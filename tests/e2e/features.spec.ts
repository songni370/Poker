import { expect, test } from '@playwright/test'
import {
  createRoom,
  dismissResult,
  exitRoom,
  joinRoomByLink,
  leaveSeat,
  openDrawerSection,
  startHand,
  takeSeat,
  watchErrors,
} from './room-helpers.ts'

/**
 * 体验与节奏功能的浏览器验收：
 *   1. 聊天：房主发言 → 对手在抽屉里看到；未读数可见；重连后仍能看到历史；
 *   2. 观战：座位满了仍能进来观战，看不到任何底牌、没有操作区，有人离座后可以入座。
 *
 * 全下逐张亮公共牌属于时序行为，由 tests/features.test.ts 在协议层断言（更稳定）。
 */

test.describe.configure({ mode: 'serial' })

test('聊天：房主发言对手能看到，刷新后仍能看到历史，未读数在按钮上可读', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const hostName = `房主${Date.now() % 1000}`
  const roomId = await createRoom(host, hostName)
  const guestName = `客人${Date.now() % 1000}`
  await joinRoomByLink(guest, roomId, guestName)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)

  // 房主发一条消息
  const text = `你好 ${String(Date.now() % 10000)}`
  await openDrawerSection(host, '聊天')
  await host.getByPlaceholder('说点什么…').fill(text)
  await host.getByRole('button', { name: '发送' }).click()
  await expect(host.getByText(text)).toBeVisible()

  // 对手的「聊天」按钮应出现未读提示（数字 + aria-label，不只是红点）
  const chatButton = guest.getByRole('button', { name: /聊天/ }).first()
  await expect(chatButton).toHaveAttribute('aria-label', /[1-9]\d* 条未读消息/)
  await openDrawerSection(guest, '聊天')
  await expect(guest.getByText(text)).toBeVisible()
  await expect(chatButton).toHaveAttribute('aria-label', '聊天，没有未读消息')

  // 关掉聊天面板后再来一条消息：重新打开时应出现「以下为新消息」分隔线。
  // 聊天已从 p-drawer 迁到左上角 HUD 浮层，关闭方式是再次点击「聊天」胶囊
  // （或点击面板外部空白），不再有抽屉关闭按钮。
  // 关闭聊天面板：再次点击「聊天」胶囊（HUD 浮层的关闭方式）
  await openDrawerSection(guest, '聊天')
  await expect(chatButton).toHaveAttribute('aria-expanded', 'false')
  // 已读锚点在关闭瞬间记录；它同时驱动「以下为新消息」分隔线，关闭后必须可读。
  await expect
    .poll(async () => guest.evaluate(() => document.querySelectorAll('.hud-chat-divider').length), { timeout: 3000 })
    .toBeGreaterThanOrEqual(0)
  await guest.waitForTimeout(200)
  await host.getByPlaceholder('说点什么…').fill('第二条消息')
  await host.getByRole('button', { name: '发送' }).click()
  await guest.waitForTimeout(300)
  await expect(guest.locator('.hud-chat-divider', { hasText: '以下为新消息' })).toBeAttached()
  // 消息正文：聊天列表是 140px 的滚动区，最新消息由代码自动滚到底；
  // 断言「在列表里」而不是「在视口里」，避免受滚动位置影响。
  await expect(guest.locator('.hud-chat-item', { hasText: '第二条消息' })).toBeAttached()

  // ── 房间事件进聊天日志（服务端 system 消息） ──
  // 系统消息：HUD 浮层里是 .hud-chat-item.is-system（旧抽屉的 .chat-system 已不存在）
  await expect(guest.locator('.hud-chat-item.is-system').first()).toBeAttached()

  // ── @ 提醒：被提到的人看到文字标记，按钮名称里也报出来 ──
  await host.getByPlaceholder('说点什么…').fill(`@${guestName} 该你了`)
  await host.getByRole('button', { name: '发送' }).click()
  await expect(guest.locator('.hud-chat-item.is-mention').first()).toBeAttached()
  await expect(chatButton).toHaveAttribute('aria-label', /条提到了你/)

  // 点击对方昵称把 @ 插入输入框：HUD 浮层的等价交互（旧抽屉的「插入 @ 提及」按钮已不存在）。
  // 昵称在 140px 滚动区里可能不在视口内，先滚进去再点。
  const sender = guest.locator('.hud-msg-sender').filter({ hasText: hostName }).first()
  await expect(sender).toBeAttached()
  await sender.evaluate((el) => (el as HTMLElement).click())
  await expect(guest.getByPlaceholder('说点什么… (Enter)')).toHaveValue(new RegExp(`@${hostName}`))

  // 刷新后聊天历史仍在（服务端下发 chatHistory）
  await guest.reload()
  await guest.waitForURL(/\/table\//)
  await openDrawerSection(guest, '聊天')
  await expect(guest.locator('.hud-chat-item', { hasText: text })).toBeAttached()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

test('聊天分组：同一个人连续发言只显示一次昵称，@ 提醒可见', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const hostName = `分组${String(Date.now() % 1000)}`
  const guestName = `听众${String(Date.now() % 1000)}`
  const roomId = await createRoom(host, hostName)
  await joinRoomByLink(guest, roomId, guestName)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)

  // 同一个人连发三条：HUD 浮层里只有第一条带昵称，后两条标记为 is-continuation。
  await openDrawerSection(host, '聊天')
  for (const line of ['第一句', '第二句', '第三句']) {
    await host.getByPlaceholder('说点什么…').fill(line)
    await host.getByRole('button', { name: '发送' }).click()
  }
  const ownMessages = host.locator('.hud-chat-item.is-own')
  await expect(ownMessages).toHaveCount(3)
  await expect(ownMessages.nth(0)).not.toHaveClass(/is-continuation/)
  await expect(ownMessages.nth(1)).toHaveClass(/is-continuation/)
  await expect(ownMessages.nth(2)).toHaveClass(/is-continuation/)
  // 三条共用一个组首昵称：页面上「你:」只出现一次
  await expect(host.locator('.hud-chat-item.is-own .hud-msg-sender')).toHaveCount(1)
  // 分组只影响视觉：后两条仍要有读屏文本说明是谁说的
  await expect(ownMessages.nth(1)).toContainText('你')

  // 别人插话后，同一个人再发言要重新起一组
  await openDrawerSection(guest, '聊天')
  await guest.getByPlaceholder('说点什么…').fill('插一句')
  await guest.getByRole('button', { name: '发送' }).click()
  await host.getByPlaceholder('说点什么…').fill('第四句')
  await host.getByRole('button', { name: '发送' }).click()
  await expect(host.locator('.hud-chat-item.is-own')).toHaveCount(4)
  await expect(host.locator('.hud-chat-item.is-own').nth(3)).not.toHaveClass(/is-continuation/)

  // @ 提醒：被提到的人在客人那边看到 is-mention 标记
  await host.getByPlaceholder('说点什么…').fill(`@${guestName} 到你了`)
  await host.getByRole('button', { name: '发送' }).click()
  await expect(guest.locator('.hud-chat-item.is-mention').first()).toBeAttached()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

test('观战：座位满仍可进入观战，看不到底牌也没有操作区，空位后可入座', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const watcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const watcher = await watcherContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest), ...watchErrors(watcher)]

  // 固定 9 人桌（大厅不再选座位数）：这里只坐两人，第三人以观战身份进桌
  const roomId = await createRoom(host, `房主${Date.now() % 1000}`)
  await joinRoomByLink(guest, roomId, `客人${Date.now() % 1000}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await joinRoomByLink(watcher, roomId, `观战${Date.now() % 1000}`)
  await startHand(host)

  /*
   * 顶部细通知条（本轮新增）：主持人开局后，观众应看到一行「第 1 手牌开始」；
   * 高度必须很克制（单行 ~26px、两条 ~64px），绝不能把牌桌顶下去。
   * 注意用开局事件而不是「加入了房间」：那条广播发生在观众进桌之前，他收不到（历史快照也不回放）。
   */
  const strip = watcher.locator('.notice-strip')
  await expect(strip).toBeVisible({ timeout: 10_000 })
  await expect(strip).toContainText('第 1 手牌开始')
  const stripBox = await strip.boundingBox()
  expect(stripBox, '通知条应可测量').not.toBeNull()
  expect(stripBox!.height, '通知条高度必须很小（不占位置）').toBeLessThanOrEqual(70)
  // 通知条必须落在顶栏与牌桌之间：不能压住顶栏，也不能压住牌桌
  const layout = await watcher.evaluate(() => ({
    barBottom: Math.round(document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0),
    stripTop: Math.round(document.querySelector('.notice-strip')?.getBoundingClientRect().top ?? 0),
    stripBottom: Math.round(document.querySelector('.notice-strip')?.getBoundingClientRect().bottom ?? 0),
    tableTop: Math.round(document.querySelector('.table')?.getBoundingClientRect().top ?? 0),
  }))
  expect(layout.stripTop, '通知条应在顶栏之下').toBeGreaterThanOrEqual(layout.barBottom)
  expect(layout.stripBottom, '通知条应在牌桌之上').toBeLessThanOrEqual(layout.tableTop)

  // 观战者：能看到牌桌与观战面板，但没有可执行的动作、没有底牌。
  // 底部操作栏本身会渲染（第 3 项需求把「退出房间」搬了进去），但一个动作按钮都不该有。
  await expect(watcher.getByText('观战中')).toBeVisible()
  await expect(watcher.locator('.action-bar .buttons .p-button')).toHaveCount(0)
  await expect(watcher.getByRole('button', { name: '开始牌局' })).toHaveCount(0)
  await expect(watcher.locator('.hero-cards [role="img"]')).toHaveCount(0)
  // 对局进行中，观战者 DOM 里不应出现任何正面牌（背面牌不计）
  const faceUp = await watcher.locator('[role="img"]:not([aria-label="盖住的牌"])').count()
  expect(faceUp).toBe(0)

  // 客人「离座」：座位与筹码保留，别人坐不进来（第 6 项）
  await leaveSeat(guest)
  await expect(guest.locator('.spectator-state')).toContainText('已离座')
  // 离座会弃牌并结算本手：先关掉结算叠层（模态遮罩会挡住桌面上的「坐回」按钮）
  await dismissResult(guest)
  await expect(guest.locator('.seat-empty.is-reserved')).toHaveCount(1)
  await expect(guest.getByRole('button', { name: /坐回 \d+ 号座位/ })).toBeVisible()
  // 别人也要能看出来这个座位「人走了、座位还在」：座位上显示「已离座」（第 4 项需求改成了小胶囊）
  await expect(host.locator('.away-pill')).toHaveCount(1)
  await expect(host.locator('.away-pill')).toContainText('已离座')
  // 座位仍占着：那个座位不会被当成空位（9 人桌剩下的空位照常可点）
  await expect(watcher.locator('.seat-empty')).toHaveCount(7)

  // 客人「坐回」：筹码照旧，直接回到座位（离座弃牌后本手已结算，先关掉结算叠层）
  await dismissResult(guest)
  await guest.getByRole('button', { name: /坐回 \d+ 号座位/ }).click()
  await expect(guest.locator('.hero-cards')).toBeVisible()

  // 只有「退出房间」才真正释放座位 → 观战者这时才能落座
  await exitRoom(guest)
  // 乙离座弃牌时本手已结算，观战者那边也会弹结算叠层：模态遮罩会挡住桌面上的空位
  await dismissResult(watcher)
  /*
   * 第 3 项需求：底部不再有「选择座位」面板，落座入口只有桌面上的空位
   *（.seat-empty 自带座位号与「入座」字样）。这里同时把「没有第二套选座 UI」钉住。
   */
  await expect(watcher.locator('.spectator-seat-picker')).toHaveCount(0)
  await expect(watcher.locator('.seat-picker')).toHaveCount(0)
  await expect(watcher.locator('.table .seat-empty')).toHaveCount(8, { timeout: 10_000 })

  // 点桌面空位（客人刚腾出来的 2 号位）→ 买入确认 → 落座
  await takeSeat(watcher, 2)
  await expect(watcher.getByText('观战中')).toBeHidden({ timeout: 10_000 })
  await expect(watcher.locator('.hero-cards')).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
  await watcherContext.close()
})

test('中等宽度顶栏收纳：顶栏保持一行，聊天/历史入口不挤压房间信息', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const guestContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `收纳${String(Date.now() % 1000)}`)
  await joinRoomByLink(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)

  // 顶栏必须保持一行（修复前 900px 会折成两行，61px → 121px）
  const barBox = await host.locator('.bar').boundingBox()
  expect(barBox?.height ?? 0).toBeLessThan(80)

  // 聊天 / 手牌历史已迁到桌面上的 HUD 胶囊（顶栏只剩配置与分享），
  // 它们必须在中等宽度下仍然可见、可展开。
  const chatPill = host.getByRole('button', { name: /^聊天/ }).first()
  await expect(chatPill).toBeVisible()
  await chatPill.click()
  await expect(host.getByPlaceholder('说点什么… (Enter)')).toBeVisible()
  await expect(host.getByRole('button', { name: /手牌历史/ }).first()).toBeVisible()

  // 房间名与盲注胶囊不能被挤出顶栏
  await expect(host.locator('.bar-title')).toBeVisible()
  await expect(host.locator('.meta-pill--blind')).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
test('房间号：纯数字，大厅可以按号加入，非数字当场拦下', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `房主${String(Date.now() % 1000)}`)
  expect(roomId, '建房返回的房间号应是 6 位纯数字').toMatch(/^[1-9]\d{5}$/)

  await guest.goto('/')
  await expect(guest.locator('#join-code')).toHaveAttribute('inputmode', 'numeric')
  await expect(guest.locator('#join-code')).toHaveAttribute('maxlength', '6')
  await guest.getByPlaceholder('例如：小满').fill(`按号${String(Date.now() % 1000)}`)

  // 非数字：大厅当场给出可执行的提示，不白跑一趟服务端；焦点回到房间号输入框。
  await guest.locator('#join-code').fill('12ab56')
  await guest.getByRole('button', { name: '进入牌桌' }).click()
  await expect(guest.getByRole('alert')).toContainText('房间号是 6 位数字')
  await expect(guest.locator('#join-code')).toBeFocused()

  // 按号加入：落在邀请链接同一个牌桌页，先当旁观者。
  // 大厅按号加入需要房间密码，统一填测试房密码 123456。
  await guest.locator('#join-code').fill(roomId)
  await guest.locator('#join-room-password').fill('123456')
  await guest.getByRole('button', { name: '进入牌桌' }).click()
  await guest.waitForURL(new RegExp(`/table/${roomId}$`))
  await expect(guest.locator('.table')).toBeVisible()
  await expect(guest.getByText('观战中')).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

/**
 * 邀请面板（抽屉里的「邀请」分节）：
 * 房间号是纯数字后要真的能念、能发出去——所以这里验四件事：
 *   ① 房间号与邀请链接的来源（路由 / 凭证）一致；
 *   ② 复制有明确反馈，且剪贴板里就是那串文本；
 *   ③ 局域网 http 明文（非安全上下文）没有 navigator.clipboard 时，退到「已选中，按 Ctrl/⌘+C」；
 *   ④ 顶栏多一个入口也不能折成两行，窄屏仍能从「更多」进得去。
 */
test('邀请：弹窗里给出房间号与邀请链接，复制有反馈，没有剪贴板时退到手动复制', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'])
  const host = await hostContext.newPage()
  const errors = watchErrors(host)

  const roomId = await createRoom(host, `房主${String(Date.now() % 1000)}`)
  const link = `${new URL(host.url()).origin}/table/${roomId}`

  // 宽屏：顶栏有直达入口（「分享」）。
  await host.getByRole('button', { name: '分享房间' }).click()
  const panel = host.locator('.invite-pane')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.invite-code')).toHaveText(roomId)

  // 内容不能横向溢出（长链接 + 按钮挤在一起时最容易撑破弹窗）。
  const fit = await panel.evaluate((section) => {
    const pick = (element: Element | null) => {
      const rect = element!.getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
    }
    return {
      section: pick(section),
      code: pick(section.querySelector('.invite-code-box')),
      input: pick(section.querySelector('.invite-input-row')),
      scrollWidth: section.scrollWidth,
      clientWidth: section.clientWidth,
    }
  })
  expect(fit.scrollWidth, `邀请分节横向溢出：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.clientWidth + 1)
  expect(fit.code.right, `房间号号牌超出分节：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.section.right + 1)
  expect(fit.input.right, `链接框超出分节：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.section.right + 1)

  // 复制邀请链接 / 复制房间号：反馈与剪贴板内容都要对得上。
  await panel.getByRole('button', { name: /复制链接/ }).click()
  await expect(panel.locator('.copy-status')).toContainText('邀请链接')
  expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(link)
  await panel.getByRole('button', { name: /^复制$/ }).first().click()
  await expect(panel.locator('.copy-status')).toContainText('房间号')
  expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(roomId)

  // 1150px 顶栏仍保持一行
  await host.keyboard.press('Escape')
  await host.setViewportSize({ width: 1150, height: 800 })
  const barHeight = await host.evaluate(() =>
    Math.round(document.querySelector('.bar')!.getBoundingClientRect().height),
  )
  expect(barHeight, '顶栏在 1150px 仍应保持一行').toBeLessThan(80)
  expect(errors).toEqual([])
  await hostContext.close()

  /* 局域网明文部署（http://192.168.x.x:3000）：没有剪贴板 API，必须有「已选中」退路。 */
  const plainContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await plainContext.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })
  const plain = await plainContext.newPage()
  const plainErrors = watchErrors(plain)
  await joinRoomByLink(plain, roomId, `明文${String(Date.now() % 1000)}`)
  await plain.getByRole('button', { name: '分享房间' }).click()
  const plainPanel = plain.locator('.invite-pane')
  await expect(plainPanel).toBeVisible()

  await plainPanel.getByRole('button', { name: /^复制$/ }).first().click()
  await expect(plainPanel.locator('.copy-status')).toContainText('已选中')
  expect(await plain.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(roomId)

  await plainPanel.getByRole('button', { name: /复制链接/ }).click()
  await expect(plainPanel.locator('.copy-status')).toContainText('已选中')
  const picked = await plain.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.invite-link-input')!
    return { start: input.selectionStart, end: input.selectionEnd, value: input.value }
  })
  expect(picked.value).toBe(link)
  expect([picked.start, picked.end], '链接应被整段选中，手按 Ctrl/⌘+C 就能复制').toEqual([0, link.length])

  expect(plainErrors).toEqual([])
  await plainContext.close()
})
