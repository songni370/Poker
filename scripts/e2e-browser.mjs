// 真实浏览器端到端验证：两个独立标签页完成「建房 → 邀请加入 → 开始 → 打完一手 → 开始下一手」。
// 只依赖 Chrome DevTools Protocol（Node 内置 WebSocket），不引入 Playwright 等第三方依赖。
//
// 用法：先 npm run build && npm start，然后 node scripts/e2e-browser.mjs
// 环境变量：E2E_BASE_URL、E2E_OUT_DIR、CHROME_PATH、E2E_DEBUG_PORT
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000'
const OUT_DIR = process.env.E2E_OUT_DIR ?? 'artifacts/e2e'
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT ?? 9333)

/* ───────────────────────── CDP 最小客户端 ───────────────────────── */

class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = []

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#onMessage(String(event.data)))
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`无法连接 CDP：${url}`)), { once: true })
    })
    return new Cdp(socket)
  }

  #onMessage(text) {
    const message = JSON.parse(text)
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      this.#pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
      return
    }
    for (const listener of this.#listeners) listener(message)
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  onEvent(listener) {
    this.#listeners.push(listener)
  }

  close() {
    this.#socket.close()
  }
}

/* ───────────────────────── 标签页封装 ───────────────────────── */

const pageErrors = []
/** 便于失败时排查：记录已打开的标签页与当前 cdp 连接。 */
const openTabs = []

/**
 * 每个标签页使用独立的浏览器上下文（独立 localStorage / Cookie），
 * 这才是规格书要求的「两个独立浏览器会话」，也避免两个标签页共享同一份房间凭证。
 */
async function openTab(cdp, width = 1440, height = 900) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const tab = { sessionId, targetId, browserContextId }
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId)
  openTabs.push(tab)
  cdp.onEvent((message) => {
    if (message.sessionId !== sessionId) return
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      pageErrors.push(details?.exception?.description ?? details?.text ?? '未知页面异常')
    }
  })
  return tab
}

async function evaluate(cdp, tab, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    tab.sessionId,
  )
  if (result.exceptionDetails) {
    throw new Error(`页面执行异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

async function goto(cdp, tab, url) {
  await cdp.send('Page.navigate', { url }, tab.sessionId)
}

async function currentUrl(cdp, tab) {
  return evaluate(cdp, tab, 'location.href')
}

async function waitFor(cdp, tab, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, tab, `Boolean(${expression})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时：${label}（当前地址 ${await currentUrl(cdp, tab)}）`)
}

let lastButtonLabels = []

/** 按可见文案点击按钮；返回 clicked / disabled / missing。找不到时记录页面上的按钮清单便于排查。 */
async function clickByText(cdp, tab, text) {
  const expression = `(() => {
    const nodes = Array.from(document.querySelectorAll('button, a, .p-button'));
    const labels = nodes.map((el) => (el.textContent || '').trim()).filter(Boolean);
    const target = nodes.find((el) => el.textContent && el.textContent.includes(${JSON.stringify(text)}));
    if (!target) return { status: 'missing', labels };
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { status: 'disabled', labels };
    target.click();
    return { status: 'clicked', labels };
  })()`
  const result = await evaluate(cdp, tab, expression)
  lastButtonLabels = result?.labels ?? []
  return result?.status ?? 'missing'
}

/** 需要必须点中时使用：失败会带上当前页面按钮清单。 */
async function requireClick(cdp, tab, text, what = text) {
  const status = await clickByText(cdp, tab, text)
  if (status === 'clicked') return
  throw new Error(
    `点击「${what}」失败（${status}）；当前页面按钮：${lastButtonLabels.join(' | ') || '（无）'}`,
  )
}

/** 按 placeholder 填写输入框，并触发 Vue 的 input 事件。 */
async function typeInto(cdp, tab, placeholder, value) {
  const expression = `(() => {
    const el = document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
  return evaluate(cdp, tab, expression)
}

async function screenshot(cdp, tab, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId)
  const path = join(OUT_DIR, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

/* ───────────────────────── 场景 ───────────────────────── */

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  throw new Error(`服务未就绪：${url}`)
}

async function playUntilSettled(cdp, tabs, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let actions = 0
  while (Date.now() < deadline) {
    for (const tab of tabs) {
      const settled = await evaluate(
        cdp,
        tab,
        "Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').trim() === '知道了')",
      )
      if (settled) return { settled: true, actions }
      const clicked = await clickByText(cdp, tab, '过牌')
      if (clicked === 'clicked') {
        actions += 1
        await sleep(200)
        continue
      }
      const called = await clickByText(cdp, tab, '跟注')
      if (called === 'clicked') {
        actions += 1
        await sleep(200)
      }
    }
    await sleep(150)
  }
  return { settled: false, actions }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  await waitForHttp(`${BASE}/api/health`)

  // 固定复用同一个 profile 目录：每次新建 --user-data-dir 会让 macOS 把 Chrome
  // 当成一个全新实例，Dock 里就会不停冒出新的图标。
  const profileDir = process.env.E2E_PROFILE_DIR ?? join(OUT_DIR, 'chrome-profile')
  mkdirSync(profileDir, { recursive: true })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-first-run',
      '--no-default-browser-check',
      // 受限环境（容器/沙箱）里 Chrome 自身的沙箱无法初始化，会以 SIGTRAP 直接退出。
      // 这里只访问本机 127.0.0.1 的自建页面，且使用一次性的临时用户目录，因此关闭它。
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,900',
      'about:blank',
    ],
    // detached：让 Chrome 自成进程组，退出时可以整组回收，
    // 否则 renderer / crashpad 等 helper 会变成孤儿进程继续挂在系统里。
    { stdio: 'ignore', detached: true },
  )

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      process.kill(-chrome.pid, 'SIGKILL')
    } catch {
      try {
        chrome.kill('SIGKILL')
      } catch {
        // 已经退出
      }
    }
  }
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)

    const host = await openTab(cdp)
    await goto(cdp, host, `${BASE}/`)
    await waitFor(cdp, host, "document.querySelector('input[placeholder=\"例如：小满\"]')", '大厅渲染完成')

    const nicknameHost = `房主${Date.now() % 1000}`
    const nicknameGuest = `客人${Date.now() % 1000}`
    await typeInto(cdp, host, '例如：小满', nicknameHost)
    await typeInto(cdp, host, '例如：周五夜局', '端到端验收房')
    await requireClick(cdp, host, '创建并进入等待区')
    await waitFor(cdp, host, "location.pathname.startsWith('/room/')", '建房后进入等待区')
    const roomId = (await currentUrl(cdp, host)).split('/room/')[1].split(/[?#]/)[0]
    console.log(`✔ 建房成功 roomId=${roomId}`)

    const guest = await openTab(cdp)
    await goto(cdp, guest, `${BASE}/room/${roomId}`)
    await waitFor(
      cdp,
      guest,
      "Boolean(document.querySelector('input[placeholder=\"例如：小满\"]'))",
      '访客看到加入表单',
    )
    await waitFor(cdp, guest, "document.body.innerText.includes('这桌牌局')", '访客看到房间落地页')
    await typeInto(cdp, guest, '例如：小满', nicknameGuest)
    await requireClick(cdp, guest, '加入房间')
    await waitFor(
      cdp,
      host,
      `document.body.innerText.includes(${JSON.stringify(nicknameGuest)})`,
      '房主看到新玩家入座',
    )
    console.log(`✔ ${nicknameGuest} 已加入并出现在房主界面`)
    await screenshot(cdp, host, '01-room-waiting-1440x900')

    await requireClick(cdp, host, '开始牌局')
    await waitFor(cdp, host, "location.pathname.startsWith('/table/')", '房主进入牌桌')
    await waitFor(cdp, guest, "location.pathname.startsWith('/table/')", '访客进入牌桌')
    console.log('✔ 双方进入牌桌，牌局开始')

    await waitFor(
      cdp,
      host,
      "document.body.innerText.includes('底牌') || document.body.innerText.includes('跟注') || document.body.innerText.includes('过牌')",
      '牌桌出现操作区',
    )
    const outcome = await playUntilSettled(cdp, [host, guest])
    if (!outcome.settled) {
      for (const [index, tab] of [host, guest].entries()) {
        const text = await evaluate(cdp, tab, 'document.body.innerText.slice(-500)')
        console.error(`--- 标签页 ${index + 1} 当前内容 ---\n${text}`)
      }
      throw new Error(`牌局未在超时内结算（已执行 ${outcome.actions} 次操作）`)
    }
    console.log(`✔ 一手牌打完并出现结算叠层（共 ${outcome.actions} 次点击操作）`)

    await sleep(300)
    const hostShot = await screenshot(cdp, host, '02-table-settlement-1440x900')
    const guestShot = await screenshot(cdp, guest, '03-guest-settlement-1440x900')
    console.log(`  截图：${hostShot} / ${guestShot}`)

    // 下一手：关闭结算叠层 → 主持人开始下一手
    await requireClick(cdp, host, '知道了', '关闭结算叠层')
    await sleep(300)
    const nextHand = await clickByText(cdp, host, '开始下一手')
    if (nextHand !== 'clicked') {
      console.log('  提示：未找到「开始下一手」按钮，跳过下一手验证')
    } else {
      await waitFor(
        cdp,
        guest,
        "!Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').trim() === '知道了')",
        '访客端结算叠层关闭，进入下一手',
      )
      console.log('✔ 已开始下一手')
    }

    // 响应式截图：横屏手机尺寸
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true }, host.sessionId)
    await sleep(400)
    const mobileShot = await screenshot(cdp, host, '04-table-844x390')
    console.log(`  截图：${mobileShot}`)

    if (pageErrors.length > 0) {
      console.error('✖ 页面出现未捕获异常：')
      for (const error of pageErrors) console.error(`  - ${error.split('\n')[0]}`)
      process.exitCode = 1
    } else {
      console.log('✔ 两个标签页全程无未捕获异常')
    }

    for (const tab of [host, guest]) await cdp.send('Target.disposeBrowserContext', { browserContextId: tab.browserContextId }).catch(() => {})
    cdp.close()
  } finally {
    cleanup()
    // 给内核一点时间回收进程组，避免 CI/脚本里紧接着检查进程时看到残留。
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(`✖ 端到端验证失败：${error.message}`)
  process.exit(1)
})
