import { expect, test, type Page } from '@playwright/test'
import {
  createRoom,
  dismissResult,
  joinRoomByLink,
  playUntilSettled,
  readHoleCards,
  startHand,
  takeSeat,
  watchErrors,
} from './room-helpers.ts'

/**
 * 端到端验收（规格书第 3/4/5 阶段）：
 *   1. 单次部署后一个端口同时提供网页、HTTP API 与 WebSocket；
 *   2. 两个**独立浏览器上下文**（各自独立 localStorage）建房入座并打完一手；
 *   3. 摊牌之前，主机页面里不得出现对手的底牌；
 *   4. 对局中刷新页面能自动重连并恢复同一手牌；
 *   5. 结算后可以开始下一手。
 */

test.describe.configure({ mode: 'serial' })

test('部署验收：一个端口同时提供网页、HTTP API 与 WebSocket', async ({ page, request }) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  const body = (await health.json()) as { ok: boolean; dbMigration: number; dbPath: string }
  expect(body.ok).toBe(true)
  expect(body.dbMigration).toBeGreaterThanOrEqual(1)
  expect(body.dbPath).toMatch(/\.sqlite$/)

  // 同一个 origin 提供页面
  const home = await request.get('/')
  expect(home.status()).toBe(200)
  expect(home.headers()['content-type']).toContain('text/html')

  // SPA 深链回落到 index.html，API 未知路径不回落到页面
  expect((await request.get('/table/not-a-real-room')).status()).toBe(200)
  expect((await request.get('/api/does-not-exist')).status()).toBe(404)

  // WebSocket 同端口握手成功
  await page.goto('/')
  const upgraded = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
        socket.addEventListener('open', () => {
          socket.close()
          resolve(true)
        })
        socket.addEventListener('error', () => resolve(false))
        setTimeout(() => resolve(false), 5000)
      }),
  )
  expect(upgraded).toBe(true)
})

test('两个独立会话打完一手：摊牌前不泄露对手底牌，结算后可开下一手', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const hostErrors = watchErrors(host)
  const guestErrors = watchErrors(guest)

  // 买入区间由房主设定（默认 2000–5000）：这里把下限放到 1000，好验证「按自己填的金额买入」
  const roomId = await createRoom(host, `房主${Date.now() % 1000}`, '端到端验收房', { minBuyIn: 1000 })
  // 新流程：建房后直接落在牌桌，房主自己先选座买入
  await takeSeat(host, 1, 1200)
  await expect(host.locator('.seat-slot').first()).toContainText('1200')
  await host.screenshot({ path: 'artifacts/e2e/01-seat-buyin-1440x900.png' })

  await joinRoomByLink(guest, roomId, `客人${Date.now() % 1000}`)
  await takeSeat(guest, 2)
  // 房主界面应看到新玩家入座（服务端广播）
  await expect(host.locator('.table')).toContainText('客人')

  await startHand(host)

  // 双方各自拿到两张底牌，且互不相同
  const hostCards = await readHoleCards(host)
  const guestCards = await readHoleCards(guest)
  expect(hostCards).toHaveLength(2)
  expect(guestCards).toHaveLength(2)
  expect(new Set([...hostCards, ...guestCards]).size).toBe(4)

  // ── 信息安全：摊牌之前，房主页面里不得出现对手的底牌 ──
  for (const card of guestCards) {
    await expect(host.locator(`[role="img"][aria-label="${card}"]`)).toHaveCount(0)
  }
  // 反向对照：房主自己的底牌确实在页面上（证明上面的检查不是空跑）
  for (const card of hostCards) {
    await expect(host.locator(`[role="img"][aria-label="${card}"]`).first()).toBeVisible()
  }

  // ── 对局中刷新：凭本地凭证自动重连并回到同一手牌 ──
  const handBefore = await guest.locator('body').innerText()
  const handNoBefore = /第\s*(\d+)\s*手/.exec(handBefore)?.[1] ?? null
  await guest.reload()
  await guest.waitForURL(/\/table\//)
  await expect(guest.getByText('已连接')).toBeVisible()
  await expect(guest.locator('.hero-cards [role="img"]')).toHaveCount(2)
  const handAfter = await guest.locator('body').innerText()
  // 顶栏把「第 N 手」拆成多个元素渲染，innerText 里是换行而不是空格。
  if (handNoBefore) expect(handAfter).toMatch(new RegExp(`第\\s*${handNoBefore}\\s*手`))
  expect([...guestCards].sort()).toEqual([...(await readHoleCards(guest))].sort())

  // ── 打完这一手 ──
  expect(await playUntilSettled([host, guest])).toBe(true)
  await expect(host.getByRole('button', { name: '知道了' })).toBeVisible()
  await host.screenshot({ path: 'artifacts/e2e/02-table-settlement-1440x900.png' })
  await guest.screenshot({ path: 'artifacts/e2e/03-guest-settlement-1440x900.png' })

  // 结算叠层里应出现赢家与牌型，且不再显示他人底牌之外的私密信息
  await expect(host.getByText(/本手结算|本手你未赢下底池|你赢得/).first()).toBeVisible()

  // ── 开始下一手 ──
  await dismissResult(host)
  await startHand(host)
  await expect(host.getByRole('button', { name: '知道了' })).toBeHidden()
  await expect
    .poll(async () => /第\s*2\s*手/.test(await host.locator('body').innerText()), { timeout: 10_000 })
    .toBe(true)

  // 横屏手机尺寸截图（响应式证据）
  await guest.setViewportSize({ width: 844, height: 390 })
  await guest.waitForTimeout(300)
  await guest.screenshot({ path: 'artifacts/e2e/04-table-844x390.png' })

  expect(hostErrors).toEqual([])
  expect(guestErrors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

test('手机横屏无溢出：844×390 与 740×360 不出现横向滚动', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = watchErrors(page)

  for (const [width, height] of [
    [844, 390],
    [740, 360],
  ] as const) {
    await page.setViewportSize({ width, height })
    // 大厅 + 牌桌（旁观态）都渲染一遍，确保两种布局都受检
    await page.goto('/')
    const lobbyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(lobbyOverflow, `大厅在 ${width}×${height} 不应横向溢出`).toBe(0)

    const roomId = await createRoom(page, `手机${Date.now() % 1000}`, '手机布局检查')
    await expect(page.getByText('观战中')).toBeVisible()
    const tableOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(tableOverflow, `牌桌在 ${width}×${height} 不应横向溢出`).toBe(0)
    expect(roomId).toBeTruthy()
  }

  expect(errors).toEqual([])
  await context.close()
})

/**
 * 牌桌几何回归（规格书 §3.4「小屏不遮挡手牌、玩家下注、底池和操作」）。
 *
 * 这一条专门守住「矮屏紧凑环形布局」：740×360 时桌面只有 ~118px 高，
 * 修复前本人座位面板会压住底池、公共牌区与座位面板只差几像素。
 * 用 9 人桌上限的房间开局，座位锚点与 9 人满桌一致（座位数决定环形角度）。
 */
test('牌桌小屏几何：740×360 / 844×390 / 390×844 无横向溢出且座位不压中央区', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `几何${String(Date.now() % 1000)}`, '几何回归')
  await joinRoomByLink(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)
  await expect(host.locator('.table')).toBeVisible()

  /** 采集：横向溢出量、每个座位面板与中央块（底池/公共牌）的重叠。 */
  async function geometry(page: Page) {
    return page.evaluate(() => {
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
      const overlap = (a: DOMRect, b: DOMRect) => {
        const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        const h = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        return v > 0.5 && h > 0.5 ? { v: Math.round(v), h: Math.round(h) } : null
      }
      const center = box(document.querySelector('.center'))
      const collisions: string[] = []
      document.querySelectorAll('.seat-slot').forEach((slot, index) => {
        if (!center) return
        const hit = overlap(slot.getBoundingClientRect(), center)
        if (hit) collisions.push(`座位${String(index + 1)} 压住中央区 ${String(hit.v)}×${String(hit.h)}px`)
      })
      const table = box(document.querySelector('.table'))
      const board = box(document.querySelector('.board .row'))
      const heroSlot = document.querySelector('.seat-slot.is-hero-slot')
      const heroBox = heroSlot ? heroSlot.getBoundingClientRect() : null
      return {
        // 本人座位：底部中央（x 居中、y 在桌面下半部分）、且桌面上不画本人底牌
        hero: heroBox && table
          ? {
              centeredX: Math.abs(heroBox.left + heroBox.width / 2 - (table.left + table.width / 2)) < 12,
              belowMiddle: heroBox.top > table.top + table.height / 2,
              seatCards: heroSlot?.querySelectorAll('.cards').length ?? -1,
              roleBadges: heroSlot?.querySelectorAll('.role-badge').length ?? -1,
            }
          : null,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        collisions,
        tableH: Math.round(table?.height ?? 0),
        boardInsideTable: Boolean(table && board && board.top >= table.top && board.bottom <= table.bottom),
        seatCount: document.querySelectorAll('.seat-slot').length,
      }
    })
  }

  for (const [width, height] of [
    [740, 360],
    [844, 390],
    [390, 844],
  ] as const) {
    await host.setViewportSize({ width, height })
    await host.waitForTimeout(250)
    const result = await geometry(host)
    expect(result.overflowX, `${width}×${height} 牌桌不应横向溢出`).toBe(0)
    expect(result.collisions, `${width}×${height} 座位面板不应压住底池/公共牌：${result.collisions.join('；')}`).toEqual([])
    expect(result.boardInsideTable, `${width}×${height} 公共牌应完全落在桌面内`).toBe(true)
    expect(result.seatCount).toBeGreaterThanOrEqual(2)
    // 第 4 项：本人座位固定在底部中央，且桌面上不再画本人底牌（底部操作区才有）
    expect(result.hero, `${width}×${height} 应能找到本人座位`).not.toBeNull()
    expect(result.hero?.centeredX, `${width}×${height} 本人座位应左右居中`).toBe(true)
    expect(result.hero?.belowMiddle, `${width}×${height} 本人座位应在桌面下半部分`).toBe(true)
    expect(result.hero?.seatCards, `${width}×${height} 桌面上的本人座位不应画底牌`).toBe(0)
    // 第 1 项：庄家/盲位角标画在座位面板里（不占用桌面、不会压住底牌）
    expect(result.hero?.roleBadges, `${width}×${height} 庄家/盲位角标应在座位面板内`).toBeGreaterThan(0)
    // 小屏不画桌面中央的浮动下注筹码（会压住公共牌或自己的筹码数字），
    // 本轮下注改由座位面板右下角的角标给出（盲注已经下过，所以至少有 1 个）。
    await expect(host.locator('.table .bet:visible')).toHaveCount(0)
    expect(await host.locator('.seat-slot .panel-bet:visible').count()).toBeGreaterThan(0)
    await host.screenshot({ path: `artifacts/e2e/13-table-geometry-${width}x${height}.png` })
  }

  /*
   * 竖屏高度收口（本轮优化）：390×844 与 360×740 这两个规格档必须「一屏放下」——
   * 顶栏 + 横屏引导 + 牌桌 + 底部「底牌/牌型/动作按钮/额度台」全部可见，页面不允许纵向滚动。
   * 改版前底部区在竖屏要 432px，390×844 溢出 75px；靠「底牌 58→42px、离座/退出收成图标、
   * 动作按钮中文小字不显示（仍在 aria-label 里）、额度台压扁、桌面高度按 0.268×dvh」收口。
   * 谁再把底部区或顶栏加高，这条会立刻失败。
   */
  for (const [width, height] of [
    [390, 844],
    [360, 740],
  ] as const) {
    await host.setViewportSize({ width, height })
    await host.waitForTimeout(250)
    const fit = await host.evaluate(() => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel)
        return el ? el.getBoundingClientRect() : null
      }
      const hero = rect('.hero')
      const actionBar = rect('.hero-actions')
      return {
        overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        heroBottom: Math.round(hero?.bottom ?? 0),
        actionBottom: Math.round(actionBar?.bottom ?? 0),
        viewportH: window.innerHeight,
      }
    })
    expect(fit.overflowY, `${width}×${height} 竖屏应一屏放下（不再纵向滚动）`).toBe(0)
    // 底部操作区（含最后一个动作按钮与额度台）必须完整落在视口内，不能被屏幕切掉。
    expect(fit.heroBottom, `${width}×${height} 底部区应完整可见`).toBeLessThanOrEqual(fit.viewportH)
    expect(fit.actionBottom, `${width}×${height} 操作区应完整可见`).toBeLessThanOrEqual(fit.viewportH)
    await host.screenshot({ path: `artifacts/e2e/33-portrait-fit-${width}x${height}.png` })
  }

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
