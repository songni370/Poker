// 牌桌几何探针（开发期工具，不参与生产运行）。
//
// 为什么需要它：小屏环形布局的重叠往往只有 5–15px，目测容易漏；
// 这里把座位面板、底池、边池、公共牌、下注筹码都换算到**桌面本地坐标**，
// 直接报出重叠像素数与页面溢出量，改 CSS 前后各跑一次即可确认收敛。
//
// 用法：
//   npm run dev                       # 另开一个终端：Vite 5173 + API 3000
//   node scripts/probe-table-geometry.mjs                 # 默认跑 9 人满桌与 6 人桌
//   node scripts/probe-table-geometry.mjs allIn splitPot   # 指定模拟场景（dev/mock.ts 的键）
//   BASE=http://localhost:5178 node scripts/probe-table-geometry.mjs   # 换端口
//
// 说明：模拟场景只在开发模式可用（`import.meta.env.DEV`），所以探针必须对着 Vite 跑，
// 不能对着 `dist/client` 的生产构建跑。依赖系统 Chrome（与 e2e 相同）。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const MOCKS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['fullRing', 'flop']
/**
 * 视口分两档：
 *   - **验收档**（inScope: true）：规格书要求的尺寸 + 普通手机尺寸；这里出现重叠或溢出即探针失败。
 *   - **参考档**（inScope: false）：比规格档更小的机型（如 320×568）。产品范围是「普通手机大小」，
 *     这些尺寸只打印问题、不参与退出码，避免用一个超范围的尺寸把探针判成失败。
 */
const VIEWPORTS = [
  { w: 1440, h: 900, inScope: true },
  { w: 1280, h: 720, inScope: true },
  { w: 390, h: 844, inScope: true },
  { w: 360, h: 740, inScope: true },
  // 手机横屏不再支持（第 1 项需求）：这一档只作参考，横屏会显示「请竖屏使用」。
  { w: 320, h: 568, inScope: false },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] })

function overlap(a, b) {
  const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const h = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  return v > 0.5 && h > 0.5 ? { v: +v.toFixed(1), h: +h.toFixed(1) } : null
}

let failures = 0

for (const mock of MOCKS) {
  for (const { w: width, h: height, inScope } of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`${BASE}/table/dev?mock=${mock}`)
    await page.waitForSelector('.table', { timeout: 15_000 })
    await page.waitForTimeout(400)

    const data = await page.evaluate(() => {
      const rect = (el) => {
        if (!el) return null
        const box = el.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
      }
      const table = rect(document.querySelector('.table'))
      if (!table) throw new Error('找不到 .table')
      const local = (el) => {
        const box = rect(el)
        return box
          ? {
              top: +(box.top - table.top).toFixed(1),
              bottom: +(box.bottom - table.top).toFixed(1),
              left: +(box.left - table.left).toFixed(1),
              right: +(box.right - table.left).toFixed(1),
              height: +box.height.toFixed(1),
            }
          : null
      }
      return {
        table: { w: +table.width.toFixed(1), h: +table.height.toFixed(1) },
        center: local(document.querySelector('.center')),
        pot: local(document.querySelector('.pot')),
        pots: local(document.querySelector('.pots')),
        street: local(document.querySelector('.table .board .street')),
        board: local(document.querySelector('.table .board .row')),
        dealer: local(document.querySelector('.table .dealer')),
        dealerSeat: 0,
        chips: [...document.querySelectorAll('.bet')].map((el) => ({
          seat: Number(el.dataset.seat ?? 0),
          box: local(el),
          text: el.textContent.trim(),
        })),
        // 可读文字：被别的元素压住才算问题（几何重叠本身不算）
        texts: [...document.querySelectorAll('.table .seat-slot .cards, .table .seat-slot .name, .table .seat-slot .stack, .table .seat-slot .status, .table .board .street, .table .board .card, .table .pot')].map((el) => ({
          label: `${el.className.split(' ')[0]}「${el.textContent.trim().slice(0, 6)}」`,
          owner: el.closest('.seat-slot') ? [...document.querySelectorAll('.seat-slot')].indexOf(el.closest('.seat-slot')) : -1,
          box: local(el),
        })),
        seats: [...document.querySelectorAll('.seat-slot')].map((el, index) => ({
          seat: index + 1,
          hero: el.classList.contains('is-hero-slot'),
          box: local(el),
          cards: el.querySelectorAll('.cards').length,
        })),
        tableHOffset: table.top,
        header: local(document.querySelector('.bar')),
        stage: local(document.querySelector('.stage')),
        footer: local(document.querySelector('.hero')),
        scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }
    })

    const issues = []
    // 与 e2e「牌桌小屏几何」同口径：座位面板整块都不该压住中央区（底池/边池/公共牌所在的那一列）。
    for (const seat of data.seats) {
      if (!seat.box || !data.center) continue
      const hit = overlap(seat.box, data.center)
      if (hit) issues.push(`座位${String(seat.seat)}${seat.hero ? '(你)' : ''}↔中央块 ${String(hit.v)}×${String(hit.h)}px`)
    }
    const board = data.board
    for (const seat of data.seats) {
      if (!seat.box || !board) continue
      const hit = overlap(seat.box, board)
      if (hit) issues.push(`座位${String(seat.seat)}${seat.hero ? '(你)' : ''}↔公共牌 ${String(hit.v)}px`)
    }
    for (const seat of data.seats) {
      if (!seat.box) continue
      for (const [label, box] of [
        ['底池', data.pot],
        ['边池行', data.pots],
      ]) {
        if (!box) continue
        const hit = overlap(seat.box, box)
        if (hit) issues.push(`座位${String(seat.seat)}${seat.hero ? '(你)' : ''}↔${label} ${String(hit.v)}px`)
      }
    }
    const seats = data.seats.filter((seat) => seat.box)
    for (let i = 0; i < seats.length; i += 1) {
      for (let j = i + 1; j < seats.length; j += 1) {
        const hit = overlap(seats[i].box, seats[j].box)
        if (hit) issues.push(`座位${String(seats[i].seat)}↔座位${String(seats[j].seat)} ${String(hit.v)}×${String(hit.h)}px`)
      }
    }
    // 页面溢出单独归类：参考档（比规格更小的机型）本来就放不下全部内容，
    // 属于已知限制、不计入退出码；验收档的溢出仍是 warning（不算重叠失败）。
    const warnings = []
    // 筹码/别的座位面板压住可读文字 → 真正的问题（几何重叠不等于信息被挡）
    const covers = [
      // 筹码连自己座位的文字也算遮挡（「筹码压住自己的筹码数字」正是竖屏踩过的坑）；
      // 面板只跟自己座位比较（面板不会挡住它自己的文字）。
      ...data.chips.map((chip) => ({ label: `筹码${chip.text}`, box: chip.box, ownSeat: -1 })),
      ...data.seats.map((seat) => ({ label: `座位${String(seat.seat)}面板`, box: seat.box, ownSeat: seat.seat })),
      { label: '庄家按钮', box: data.dealer, ownSeat: (data.dealerSeat ?? 0) + 1 },
    ]
    for (const text of data.texts) {
      if (!text.box) continue
      const ownerSeat = text.owner < 0 ? 0 : text.owner + 1
      for (const cover of covers) {
        if (!cover.box || cover.ownSeat === ownerSeat) continue
        const hit = overlap(text.box, cover.box)
        if (hit) issues.push(`${cover.label}压住文字 ${text.label} ${String(hit.v)}×${String(hit.h)}px`)
      }
    }
    if (data.footer && data.footer.top < (data.stage?.bottom ?? 0)) {
      for (const seat of data.seats) {
        if (!seat.box) continue
        const hit = overlap({ top: seat.box.top + data.tableHOffset, bottom: seat.box.bottom + data.tableHOffset, left: seat.box.left, right: seat.box.right }, data.footer)
        if (hit) issues.push(`座位${String(seat.seat)}${seat.hero ? '(你)' : ''}伸进底部操作区 ${String(hit.v)}px`)
      }
    }
    if (data.scrollX > 0) warnings.push(`横向溢出 ${String(data.scrollX)}px`)
    if (data.scrollY > 0) warnings.push(`纵向溢出 ${String(data.scrollY)}px`)
    if (pageErrors.length > 0) issues.push(`页面错误：${pageErrors.join(';')}`)

    failures += inScope ? issues.length : 0
    console.log(
      `\n=== mock=${mock} ${String(width)}×${String(height)}  桌面 ${String(data.table.w)}×${String(data.table.h)}` +
        (inScope ? '' : '  【参考档：超产品范围，不计入退出码】'),
    )
    console.log(`  头部 ${String(data.header.height)} · 舞台 ${String(data.stage.height)} · 底部 ${String(data.footer.height)}`)
    console.log(
      `  中心块 x ${String(data.center.left)}..${String(data.center.right)} y ${String(data.center.top)}..${String(data.center.bottom)} | 底池 ${String(data.pot.top)}..${String(data.pot.bottom)}` +
        `${data.pots ? ` | 边池行 ${String(data.pots.top)}..${String(data.pots.bottom)}` : ''}` +
        `${data.board ? ` | 公共牌 ${String(data.board.top)}..${String(data.board.bottom)}` : ''}`,
    )
    if (issues.length > 0) console.log(`  ${inScope ? '⚠ 重叠' : '· 参考档重叠（不判失败）'}：${issues.join(' | ')}`)
    if (warnings.length > 0) console.log(`  · 页面溢出（已知限制）：${warnings.join(' | ')}`)
    if (issues.length === 0 && warnings.length === 0) console.log('  ✔ 无重叠、无溢出')
    await context.close()
  }
}

await browser.close()
console.log(
  failures > 0
    ? `\n验收档共 ${String(failures)} 处重叠问题（参考档不计入）。`
    : '\n验收档（1440×900 / 1280×720 / 390×844 / 360×740）全部通过。',
)
process.exit(failures > 0 ? 1 : 0)
