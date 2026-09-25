import { expect, test } from '@playwright/test'
import {
  createRoom,
  dismissResult,
  exitRoom,
  joinRoomByLink,
  leaveSeat,
  openDrawerSection,
  playUntilSettled,
  startHand,
  takeAnyFreeSeat,
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

  const roomId = await createRoom(host, `房主${Date.now() % 1000}`)
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

  // 关掉抽屉后再来一条消息：重新打开时应出现「以下为新消息」分隔线
  await guest.locator('.p-drawer-close, [aria-label="Close"]').first().click().catch(() => guest.keyboard.press('Escape'))
  await guest.waitForTimeout(300)
  await host.getByPlaceholder('说点什么…').fill('第二条消息')
  await host.getByRole('button', { name: '发送' }).click()
  await guest.waitForTimeout(300)
  await openDrawerSection(guest, '聊天')
  await expect(guest.getByText('以下为新消息')).toBeVisible()
  await expect(guest.getByText('第二条消息')).toBeVisible()

  // ── 房间事件进聊天日志（服务端 system 消息） ──
  await expect(guest.locator('.chat-system').first()).toBeVisible()

  // ── @ 提醒：被提到的人看到文字标记，按钮名称里也报出来 ──
  await host.getByPlaceholder('说点什么…').fill(`@${guestName} 该你了`)
  await host.getByRole('button', { name: '发送' }).click()
  await expect(guest.locator('.chat-msg.is-mention').first()).toBeVisible()
  await expect(guest.locator('.chat-mention-tag').first()).toHaveText('提到了你')
  await expect(chatButton).toHaveAttribute('aria-label', /条提到了你/)

  // 插入 @ 的按钮可用（列出房内其他玩家）
  await host.getByRole('button', { name: '插入 @ 提及' }).click()
  await expect(host.getByRole('menuitem', { name: guestName })).toBeVisible()
  await host.keyboard.press('Escape')

  // ── 搜索：只留匹配消息并给出条数 ──
  await guest.getByPlaceholder('搜索消息…').fill('该你了')
  await expect(guest.getByText(/匹配 \d+ 条/)).toBeVisible()
  await expect(guest.locator('.chat-msg')).toHaveCount(1)
  await guest.getByPlaceholder('搜索消息…').fill('绝对不存在的关键词')
  await expect(guest.getByText('没有匹配的消息')).toBeVisible()
  await guest.getByRole('button', { name: '清除' }).click()
  await expect(guest.locator('.chat-msg').first()).toBeVisible()

  // 刷新后聊天历史仍在（服务端下发 chatHistory）
  await guest.reload()
  await guest.waitForURL(/\/table\//)
  await openDrawerSection(guest, '聊天')
  await expect(guest.getByText(text)).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

test('聊天分组：同一个人连续发言只显示一次昵称，@ 提醒另起一组', async ({ browser }) => {
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

  // 同一个人连发三条（间隔很短，必须折叠成一组）
  await openDrawerSection(host, '聊天')
  for (const line of ['第一句', '第二句', '第三句']) {
    await host.getByPlaceholder('说点什么…').fill(line)
    await host.getByRole('button', { name: '发送' }).click()
    await expect(host.getByText(line)).toBeVisible()
  }

  // 自己的消息靠右，三条都在
  const ownMessages = host.locator('.chat-msg.is-own')
  await expect(ownMessages).toHaveCount(3)
  // 组首有昵称与时间，其余两条标记为「组内后续」
  await expect(ownMessages.nth(0).locator('.chat-meta')).toHaveCount(1)
  await expect(ownMessages.nth(1)).toHaveClass(/is-continuation/)
  await expect(ownMessages.nth(2)).toHaveClass(/is-continuation/)
  await expect(ownMessages.nth(1).locator('.chat-meta')).toHaveCount(0)
  await expect(ownMessages.nth(2).locator('.chat-meta')).toHaveCount(0)
  // 分组只影响视觉：屏幕阅读器仍要听到后两条是谁说的
  await expect(ownMessages.nth(1)).toContainText('你')
  // 三条共用一个组首昵称，页面上「你」只出现一次（没有逐条重复）
  await expect(host.locator('.chat-msg .chat-who')).toHaveCount(1)

  // 别人插话后，同一个人再发言要重新起一组
  await openDrawerSection(guest, '聊天')
  await guest.getByPlaceholder('说点什么…').fill('插一句')
  await guest.getByRole('button', { name: '发送' }).click()
  await expect(host.getByText('插一句')).toBeVisible()
  await host.getByPlaceholder('说点什么…').fill('第四句')
  await host.getByRole('button', { name: '发送' }).click()
  await expect(host.getByText('第四句')).toBeVisible()
  await expect(host.locator('.chat-msg.is-own')).toHaveCount(4)
  await expect(host.locator('.chat-msg.is-own').nth(3)).not.toHaveClass(/is-continuation/)
  await expect(host.locator('.chat-msg.is-own').nth(3).locator('.chat-meta')).toHaveCount(1)

  // @ 提醒即使紧跟在自己的发言后面，也要单独成组（组首才有的「提到了你」标记）
  await host.getByPlaceholder('说点什么…').fill(`@${guestName} 到你了`)
  await host.getByRole('button', { name: '发送' }).click()
  const ownMention = host.locator('.chat-msg.is-own').nth(4)
  await expect(ownMention).not.toHaveClass(/is-continuation/)
  await expect(ownMention.locator('.chat-meta')).toHaveCount(1)
  // 被提到的人在客人那边：标记只对本人显示
  await expect(guest.locator('.chat-msg.is-mention').first()).toHaveClass(/is-mention/)
  await expect(guest.locator('.chat-mention-tag').first()).toHaveText('提到了你')

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
  await expect(guest.getByRole('button', { name: /坐回 \d+ 号位/ })).toBeVisible()
  // 别人也要能看出来这个座位「人走了、座位还在」：座位上显示「已离座」（第 4 项需求改成了小胶囊）
  await expect(host.locator('.away-pill')).toHaveCount(1)
  await expect(host.locator('.away-pill')).toContainText('已离座')
  // 座位仍占着：那个座位不会被当成空位（9 人桌剩下的空位照常可点）
  await expect(watcher.locator('.seat-empty')).toHaveCount(7)

  // 客人「坐回」：筹码照旧，直接回到座位（离座弃牌后本手已结算，先关掉结算叠层）
  await dismissResult(guest)
  await guest.getByRole('button', { name: /坐回 \d+ 号位/ }).click()
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

test('中等宽度顶栏收纳：只留「更多」与「退出」，菜单里仍能找到聊天/历史/规则/提示音', async ({ browser }) => {
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

  // 二级操作被收起，只剩「更多」与「退出」
  await expect(host.getByRole('button', { name: '更多操作' })).toBeVisible()
  await expect(host.getByRole('button', { name: /^聊天/ })).toBeHidden()
  await expect(host.getByRole('button', { name: '规则', exact: true })).toBeHidden()

  // 通过菜单仍可进入聊天
  await host.getByRole('button', { name: '更多操作' }).click()
  const menu = host.getByRole('menu').or(host.locator('.p-menu'))
  await expect(menu.first()).toBeVisible()
  await expect(menu.first().getByText('规则摘要')).toBeVisible()
  await expect(menu.first().getByText(/手牌历史|聊天|提示音/).first()).toBeVisible()
  await menu.first().getByText(/^聊天/).first().click()
  await expect(host.getByPlaceholder('说点什么…')).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

/**
 * 主持人移除玩家（room.kick）的浏览器验收：
 *   房主在「更多」菜单里打开「移除玩家…」→ 二次确认 → 客人被请出房间，
 *   客人页面跳到错误页（文案里要出现「移出」），房主页面上那个座位空出来。
 * 手牌进行中的释放时机（结算后才真正空出）由 tests/features.test.ts 在协议层断言，
 * 那里能精确控制牌局状态，比浏览器里等超时稳定。
 */
test('移除玩家：房主把客人移出房间，客人跳到错误页，释放的座位别人能坐', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const watcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const watcher = await watcherContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest), ...watchErrors(watcher)]

  const roomId = await createRoom(host, `房主${Date.now() % 1000}`)
  const guestName = `客人${Date.now() % 1000}`
  await joinRoomByLink(guest, roomId, guestName)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  // 第三个人是旁观者：由他来证明「座位真的空出来了」（桌面空位只对旁观者渲染）。
  // 固定 9 人桌：坐了 2 人 → 还剩 7 个空位。
  await joinRoomByLink(watcher, roomId, `观战${Date.now() % 1000}`)
  await expect(watcher.locator('.seat-empty')).toHaveCount(7)

  // 客人看不到「移除玩家」入口：这一项只属于主持人。
  // 窄屏下「更多」按钮本身会被收进媒体查询里，所以两种情况分别断言。
  const guestMore = guest.getByRole('button', { name: '更多操作' })
  if (await guestMore.isVisible()) {
    await guestMore.click()
    await expect(guest.locator('.p-menu').getByText('移除玩家…')).toHaveCount(0)
    await guest.keyboard.press('Escape')
  } else {
    await expect(guestMore).toBeHidden()
  }

  // 房主打开移除名单：自己、客人、旁观者都在列表里，自己那一行只提示「这是你」
  await host.getByRole('button', { name: '移除玩家' }).click()
  const kickDialog = host.locator('.p-dialog').filter({ hasText: '被移除的人会立刻离开房间' })
  await expect(kickDialog).toBeVisible()
  await expect(kickDialog.locator('.kick-row')).toHaveCount(3)
  await expect(kickDialog.getByText(guestName)).toBeVisible()
  await expect(kickDialog.getByText('旁观')).toBeVisible()
  await expect(kickDialog.getByText('这是你')).toBeVisible()
  // 自己不能被移除：只有另外两行有按钮
  await expect(kickDialog.getByRole('button', { name: '移除' })).toHaveCount(2)

  // 点「移除」先就地二次确认：这时候还没真的移除
  const guestRow = kickDialog.locator('.kick-row').filter({ hasText: guestName })
  await guestRow.getByRole('button', { name: '移除' }).click()
  await expect(kickDialog).toContainText(`确定把「${guestName}」移出房间吗？`)
  // 取消不会移除任何人
  await kickDialog.getByRole('button', { name: '取消' }).click()
  await expect(guestRow.getByRole('button', { name: '移除' })).toBeVisible()
  await expect(guest).toHaveURL(/\/table\//)

  await guestRow.getByRole('button', { name: '移除' }).click()
  await kickDialog.getByRole('button', { name: '确认移除' }).click()
  await expect(kickDialog.locator('.kick-row')).toHaveCount(2)

  // 客人：跳到错误页，页面文案说明是被移出（不是普通断线）
  await expect(guest).toHaveURL(/\/error/)
  await expect(guest.getByRole('heading', { name: '你已被移出房间' })).toBeVisible()
  await expect(guest.locator('.panel')).toContainText('移出')
  // 而且不能一直往牌桌重连（凭证已作废并清掉）
  await guest.waitForTimeout(800)
  await expect(guest).toHaveURL(/\/error/)

  // 释放的座位可以真的坐进去：旁观者点空位 → 确认买入 → 落座
  await kickDialog.getByRole('button', { name: '关闭' }).click()
  await takeSeat(watcher, 2)
  await expect(watcher.locator('.hero-cards')).toBeVisible()
  // 房主那边这个座位也重新有人了（不再是空缺）
  await expect(host.locator('.seat').filter({ hasText: '观战' })).toHaveCount(1)

  // 房间日志里有这条事件
  await openDrawerSection(host, '聊天')
  await expect(host.locator('.chat-system').filter({ hasText: `${guestName} 已被主持人移出房间` })).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
  await watcherContext.close()
})

/** 窄屏（≤1100px）顶栏只留「更多」：移除入口必须仍能从菜单里找到，且菜单里只有主持人看得到。 */
test('移除玩家：窄屏顶栏收进「更多」菜单时，主持人仍能从菜单里打开移除名单', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const guestContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `窄屏${Date.now() % 1000}`)
  const guestName = `陪练${Date.now() % 1000}`
  await joinRoomByLink(guest, roomId, guestName)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)

  // 窄屏：顶栏的「移除玩家」收起来了，只能从「更多」菜单进
  await expect(host.getByRole('button', { name: '移除玩家' })).toBeHidden()
  await host.getByRole('button', { name: '更多操作' }).click()
  const menu = host.locator('.p-menu')
  await expect(menu.getByText('移除玩家…')).toBeVisible()
  await menu.getByText('移除玩家…').click()
  const kickDialog = host.locator('.p-dialog').filter({ hasText: '被移除的人会立刻离开房间' })
  await expect(kickDialog).toBeVisible()
  await expect(kickDialog.locator('.kick-row')).toHaveCount(2)
  await expect(kickDialog.getByText(guestName)).toBeVisible()

  // 关掉弹窗后牌桌仍然可用（顶栏没有因为多了一项而折行）
  await kickDialog.getByRole('button', { name: '关闭' }).click()
  const barBox = await host.locator('.bar').boundingBox()
  expect(barBox?.height ?? 0).toBeLessThan(80)

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

/**
 * 桌面空位落座（第 3 项需求改版后）：
 *   底部观战面板不再有「选择座位」网格与「入座」按钮——座位号与「入座」都画在桌面的空位上，
 *   两处并存只会让人不知道该点哪个。这里在 390×844 竖屏下验证：
 *   ① 底部没有选座 UI；② 桌面上 7 个空位各自带座位号与可访问名称、触控尺寸达标、不横向溢出；
 *   ③ 点桌面第 5 个空位 → 确认买入 → 真正落座。
 */
test('桌面空位落座：窄屏点桌面空位买入即可落座，底部不再有第二套选座 UI', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const watcherContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const watcher = await watcherContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest), ...watchErrors(watcher)]

  // 不再传 maxSeats：产品固定 9 人桌（大厅也没有座位数选项了）
  const roomId = await createRoom(host, `选座${String(Date.now() % 1000)}`)
  await joinRoomByLink(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  // 第三个人以观战身份进来：9 人桌还剩 7 个空位
  await joinRoomByLink(watcher, roomId, `观战${String(Date.now() % 1000)}`)

  /* ① 底部观战面板：只有状态、已入座人数与退出按钮，没有选座网格。 */
  await expect(watcher.locator('.spectator-seat-picker')).toHaveCount(0)
  await expect(watcher.locator('.seat-picker')).toHaveCount(0)
  await expect(watcher.locator('.spectator-state')).toContainText('观战中')
  await expect(watcher.locator('.spectator-seats')).toContainText('2/9')

  /* ② 座位号与「入座」字样画在桌面的每个空位上：数量、触控尺寸、不横向溢出。 */
  const emptySeats = watcher.locator('.table .seat-empty')
  await expect(emptySeats).toHaveCount(7)
  const boxes = await emptySeats.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      const label = (node.textContent ?? '').replace(/\s+/g, '')
      return {
        label,
        aria: node.getAttribute('aria-label') ?? '',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }),
  )
  // 每个空位都带得走的座位号：视觉文案「N入座」+ aria-label「坐到 N 号座位」
  boxes.forEach((box, index) => {
    expect(box.label, `第 ${String(index + 1)} 个空位应显示座位号`).toMatch(/\d+入座/)
    expect(box.aria, `第 ${String(index + 1)} 个空位应有可访问名称`).toMatch(/坐到 \d+ 号座位/)
    expect(box.width).toBeGreaterThanOrEqual(40)
    // 空位卡是一行小卡（第 2 项需求特意缩小）；30px 是它的实际高度，仍高于 24px 的可点下限。
    expect(box.height).toBeGreaterThanOrEqual(28)
  })
  const overflowX = await watcher.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflowX, '窄屏不应横向溢出').toBe(0)

  /* ③ 点桌面第 5 个空位 → 买入确认 → 落座（新流程的完整闭环）。
        takeAnyFreeSeat 内部已覆盖「弹窗出现 → 填/用默认金额 → 确认 → 落座」全流程。 */
  await takeAnyFreeSeat(watcher, 4)
  await expect(watcher.getByText('观战中')).toBeHidden({ timeout: 10_000 })
  await expect(watcher.locator('.hero-cards')).toBeVisible()

  // 退出房间：释放座位并回到大厅（与「离座」不同）
  await exitRoom(watcher)
  await expect(watcher.getByRole('heading', { name: '开一桌德州' })).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
  await watcherContext.close()
})

/**
 * 界面改造回归（本轮 4 项需求）：
 *   1. 牌面不再画中央大花色：只有左上「点数 + 花色」与右下镜像角标；
 *   2. 座位面板左侧是牌局角色槽位（D / SB / BB），头像圆已删除，没有角色时整块不渲染；
 *   3. 底部「你的底牌」区实时显示当前最大牌型（翻牌前 → 河牌）；
 *   4. 操作区动作按钮英文主 + 中文辅，并多出 1/2、2/3、满池、超池 四个快捷额度。
 *
 * 用 3 人桌：庄家 / 小盲 / 大盲都有角色，第三家没有角色——
 * 一屏里能同时看到「有角色」与「无角色」两种座位面板。
 */
test('界面改造：牌面无中央花色、座位角色槽位、底部当前牌型、操作区快捷额度', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const thirdContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const third = await thirdContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest), ...watchErrors(third)]

  const stamp = String(Date.now() % 1000)
  const roomId = await createRoom(host, `界面${stamp}`, '界面回归')
  await joinRoomByLink(guest, roomId, `乙${stamp}`)
  await joinRoomByLink(third, roomId, `丙${stamp}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await takeSeat(third, 3)
  await startHand(host)

  /* ① 牌面：没有 .pip，两个角标，role=img + 中文 aria-label 都还在。 */
  const faces = await host.evaluate(() => {
    const cards = [...document.querySelectorAll('.table .board .card, .hero-cards .card')]
    return {
      cards: cards.length,
      pips: document.querySelectorAll('.pip').length,
      cornerCounts: cards.map((el) => el.querySelectorAll('.corner').length),
      roles: cards.map((el) => el.getAttribute('role')),
      labels: cards.map((el) => el.getAttribute('aria-label') ?? ''),
    }
  })
  expect(faces.cards).toBeGreaterThan(0)
  expect(faces.pips, '牌面上不应再有中央大花色 .pip').toBe(0)
  expect(faces.cornerCounts.every((count) => count === 2), '每张正面牌都要有左上 + 右下两个角标').toBe(true)
  expect(faces.roles.every((role) => role === 'img')).toBe(true)
  expect(
    faces.labels.every((label) => /^(黑桃|红桃|方块|梅花) /.test(label)),
    `读屏仍要读出花色与点数：${faces.labels.join('、')}`,
  ).toBe(true)

  /* ② 座位面板：没有头像，左侧是角色槽位；角色胶囊对读屏隐藏，完整说法在 aria-label。 */
  const seatInfo = await host.evaluate(() =>
    [...document.querySelectorAll('.seat-slot')].map((slot) => ({
      avatars: slot.querySelectorAll('.avatar').length,
      roles: [...slot.querySelectorAll('.roles .role-badge')].map((badge) => badge.textContent.trim()),
      rolesHidden: slot.querySelector('.roles')?.getAttribute('aria-hidden') ?? null,
      aria: slot.querySelector('.seat')?.getAttribute('aria-label') ?? '',
    })),
  )
  expect(seatInfo.length).toBeGreaterThanOrEqual(3)
  expect(seatInfo.every((seat) => seat.avatars === 0), '头像圆应已删除').toBe(true)
  const withRoles = seatInfo.filter((seat) => seat.roles.length > 0)
  // 3 人桌：庄家、小盲、大盲各占一个座位（庄家与小盲是两个人）。
  expect(withRoles.map((seat) => seat.roles.join('+')).sort()).toEqual(['BB', 'D', 'SB'])
  expect(withRoles.every((seat) => seat.rolesHidden === 'true'), '角色胶囊只是视觉').toBe(true)
  expect(withRoles.every((seat) => /庄家位|小盲|大盲/.test(seat.aria)), '完整说法仍在座位 aria-label').toBe(true)
  // 没有角色的座位：槽位整块不渲染（不是渲染成空盒子）。
  expect(withRoles.length).toBe(3)
  expect(await host.locator('.seat .roles').count()).toBe(3)

  /* ③ 翻牌前的当前牌型：两张底牌也要给结论。 */
  const handName = host.locator('.hero-hand .hand-name')
  await expect(handName).toBeVisible()
  await expect(handName).toHaveText(/^(一对 |高牌 )/)

  /* ④ 操作区：英文主 + 中文辅，且有四个快捷额度。 */
  let actor = null as typeof host | null
  for (let i = 0; i < 40 && actor === null; i += 1) {
    for (const page of [host, guest, third]) {
      if (await page.locator('.action-bar .quick-btn').first().isVisible().catch(() => false)) {
        actor = page
        break
      }
    }
    if (actor === null) await host.waitForTimeout(250)
  }
  expect(actor, '开局后总有一方轮到自己下注/加注').not.toBeNull()
  const bettor = actor!

  const actions = await bettor.evaluate(() =>
    [...document.querySelectorAll('.action-bar .buttons .p-button')].map((el) => ({
      aria: el.getAttribute('aria-label') ?? '',
      en: el.querySelector('.act-en')?.textContent?.trim() ?? '',
      zh: el.querySelector('.act-zh')?.textContent?.trim() ?? '',
      height: Math.round(el.getBoundingClientRect().height),
    })),
  )
  expect(actions.length).toBeGreaterThanOrEqual(3)
  for (const action of actions) {
    expect(action.en, '英文主文本').not.toBe('')
    expect(action.zh, '中文小字').not.toBe('')
    // 可访问名称必须同时包含英文动作词与中文，不能只留英文。
    expect(action.aria).toContain(action.en.split(' ')[0]!)
    expect(action.aria).toContain(action.zh.split(' ')[0]!)
    expect(action.height, `${action.aria} 的触控高度`).toBeGreaterThanOrEqual(40)
  }

  const quick = await bettor.evaluate(() => {
    const range = document.querySelector('.action-bar .range')?.textContent ?? ''
    const [min, max] = range.split('–').map((value) => Number(value.trim()))
    const buttons = [...document.querySelectorAll('.action-bar .quick-btn')].map((el) => {
      const box = el.getBoundingClientRect()
      return {
        // 英文是主文本（官方叫法），中文只是下方小字；两者都要在。
        en: el.querySelector('.quick-ratio')?.textContent?.trim() ?? '',
        zh: el.querySelector('.quick-zh')?.textContent?.trim() ?? '',
        value: Number(el.querySelector('.quick-value')?.textContent?.trim() ?? 'NaN'),
        disabled: el.hasAttribute('disabled'),
        title: el.closest('.quick-slot')?.getAttribute('title') ?? '',
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
    })
    return {
      min,
      max,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      buttons,
      // 相邻档位的间距：不小于 8px，手指不会点到隔壁档位。
      gaps: buttons.slice(1).map((button, index) => button.left - buttons[index]!.right),
    }
  })
  expect(quick.buttons.map((button) => button.en)).toEqual(['1/2 POT', '2/3 POT', 'POT', 'OVERBET'])
  expect(quick.buttons.map((button) => button.zh)).toEqual(['半池', '2/3 池', '满池', '超池'])
  expect(Number.isFinite(quick.min) && Number.isFinite(quick.max)).toBe(true)
  expect(quick.overflowX, '操作区不应横向溢出').toBe(0)
  for (const button of quick.buttons) {
    expect(button.height, `${button.en} 的触控高度`).toBeGreaterThanOrEqual(40)
    expect(button.width, `${button.en} 的触控宽度`).toBeGreaterThanOrEqual(40)
    expect(Number.isInteger(button.value)).toBe(true)
    // 关键：按钮上写的数必须落在服务端给的合法区间内，点下去一定不会被拒。
    expect(button.value).toBeGreaterThanOrEqual(quick.min)
    expect(button.value).toBeLessThanOrEqual(quick.max)
    expect(button.title.length, `${button.en} 要有 title 说明`).toBeGreaterThan(0)
  }
  for (const gap of quick.gaps) {
    expect(gap, '相邻快捷额度之间至少 8px').toBeGreaterThanOrEqual(8)
  }

  const potButton = bettor.locator('.action-bar .quick-btn').nth(2)
  const potValue = ((await potButton.locator('.quick-value').textContent()) ?? '').trim()
  await potButton.click()
  await expect(bettor.locator('#bet-amount')).toHaveValue(potValue)

  /* ③+ 河牌：公共牌发到 5 张后，牌型文案跟着更新（结算叠层里是引擎的同一个说法）。 */
  expect(await playUntilSettled([host, guest, third])).toBe(true)
  await expect(host.locator('.best-five .card').first()).toBeVisible()

  const settledFace = await host.evaluate(() => ({
    pips: document.querySelectorAll('.pip').length,
    // 平分底池时每个赢家各列一行「最佳五张」：这里按「每组 5 张」校验，
    // 不能写死总数 5，否则两人平分（10 张）会误判成失败。
    bestFiveGroups: [...document.querySelectorAll('.best-five')].map(
      (group) => group.querySelectorAll('.card').length,
    ),
    board: document.querySelectorAll('.table .board .card').length,
  }))
  expect(settledFace.pips, '结算叠层的最佳五张同样不画中央花色').toBe(0)
  expect(settledFace.bestFiveGroups.length, '至少要有一个赢家列出最佳五张').toBeGreaterThan(0)
  expect(
    settledFace.bestFiveGroups.every((count) => count === 5),
    `每个赢家都列 5 张：${settledFace.bestFiveGroups.join('、')}`,
  ).toBe(true)
  expect(settledFace.board).toBe(5)

  await dismissResult(host)
  const riverName = host.locator('.hero-hand .hand-name')
  await expect(riverName).toBeVisible()
  await expect(riverName).toHaveText(
    /^(高牌（|一对 |两对（|三条 |顺子（|同花（|葫芦（|四条 |同花顺（)/,
  )

  /* ②+ 单挑（双人桌）：庄家同时是小盲，同一个座位的角色槽位要同时挂 D 与 SB。 */
  await dismissResult(guest)
  // 丙也必须先关掉自己屏幕上的结算叠层：它是模态遮罩，会拦住「退出房间」的点击
  //（本手是平分底池，三个客户端都弹了结算，实测遮罩让 exitRoom 一直重试到 90s 超时）。
  await dismissResult(third)
  await exitRoom(third)
  await startHand(host)
  const headsUp = await host.evaluate(() =>
    [...document.querySelectorAll('.seat-slot')]
      .map((slot) => [...slot.querySelectorAll('.roles .role-badge')].map((badge) => badge.textContent.trim()).join('+'))
      .filter((roles) => roles !== ''),
  )
  expect(headsUp.sort()).toEqual(['BB', 'D+SB'])

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
  await thirdContext.close()
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
  await guest.getByRole('button', { name: '加入房间' }).click()
  await expect(guest.getByRole('alert')).toContainText('房间号是 6 位数字')
  await expect(guest.locator('#join-code')).toBeFocused()

  // 按号加入：落在邀请链接同一个牌桌页，先当旁观者。
  await guest.locator('#join-code').fill(roomId)
  await guest.getByRole('button', { name: '加入房间' }).click()
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
test('邀请：抽屉里给出房间号与邀请链接，复制有反馈，没剪贴板时退到手动复制', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'])
  const host = await hostContext.newPage()
  const errors = watchErrors(host)

  const roomId = await createRoom(host, `房主${String(Date.now() % 1000)}`)
  const link = `${new URL(host.url()).origin}/table/${roomId}`

  // 宽屏：顶栏有直达入口（不能只藏在窄屏的「更多」菜单里）。
  await host.getByRole('button', { name: '邀请朋友' }).click()
  const panel = host.locator('section[aria-label="邀请朋友"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.invite-code')).toHaveText(roomId)
  await expect(host.locator('#invite-link')).toHaveValue(link)

  // 分节内容不能横向溢出（长链接 + 两个按钮挤在一起时最容易撑破抽屉）。
  const fit = await panel.evaluate((section) => {
    const pick = (element: Element | null) => {
      const rect = element!.getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
    }
    return {
      section: pick(section),
      plate: pick(section.querySelector('.invite-plate')),
      input: pick(section.querySelector('#invite-link')),
      actions: pick(section.querySelector('.invite-actions')),
      scrollWidth: section.scrollWidth,
      clientWidth: section.clientWidth,
    }
  })
  expect(fit.scrollWidth, `邀请分节横向溢出：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.clientWidth + 1)
  expect(fit.plate.right, `房间号号牌超出分节：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.section.right + 1)
  expect(fit.input.right, `链接框超出分节：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.section.right + 1)
  expect(fit.actions.right, `按钮行超出分节：${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.section.right + 1)

  // 复制邀请链接 / 复制房间号：反馈文案与剪贴板内容都要对得上。
  await panel.getByRole('button', { name: '复制邀请链接' }).click()
  await expect(panel.locator('.invite-status')).toHaveText('已复制邀请链接')
  expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(link)
  await panel.getByRole('button', { name: '复制房间号' }).click()
  await expect(panel.locator('.invite-status')).toHaveText('已复制房间号')
  expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(roomId)

  // 触控目标：两个按钮都不低于 40px。
  const heights = await panel
    .locator('.invite-actions .p-button')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
  expect(heights.length).toBe(2)
  expect(heights.every((height) => height >= 40), `触控高度：${heights.join('、')}`).toBe(true)

  /* 顶栏多一个按钮：1150px 正好在「二级操作露出来」的一侧，最容易折行。 */
  await host.setViewportSize({ width: 1150, height: 800 })
  const barHeight = await host.evaluate(() =>
    Math.round(document.querySelector('.bar')!.getBoundingClientRect().height),
  )
  expect(barHeight, '顶栏必须保持一行').toBeLessThan(80)

  /* 窄屏：入口收进「更多」，四个分节标签不能横向溢出。 */
  await host.setViewportSize({ width: 360, height: 740 })
  await host
    .locator('.p-drawer-close, [aria-label="Close"]')
    .first()
    .click()
    .catch(() => host.keyboard.press('Escape'))
  await host.getByRole('button', { name: '更多操作' }).click()
  const menu = host.getByRole('menu').or(host.locator('.p-menu'))
  await menu.first().getByText('邀请朋友').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.invite-code')).toHaveText(roomId)
  const tabs = await host.evaluate(() => {
    const row = document.querySelector('.drawer-tabs')!
    return { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth }
  })
  expect(tabs.scrollWidth, '四个分节标签不能横向溢出').toBeLessThanOrEqual(tabs.clientWidth + 1)
  expect(errors).toEqual([])
  await hostContext.close()

  /* 局域网明文部署（http://192.168.x.x:3000）：没有剪贴板 API，必须有退路。 */
  const plainContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await plainContext.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })
  const plain = await plainContext.newPage()
  const plainErrors = watchErrors(plain)
  await joinRoomByLink(plain, roomId, `明文${String(Date.now() % 1000)}`)
  await plain.getByRole('button', { name: '邀请朋友' }).click()
  const plainPanel = plain.locator('section[aria-label="邀请朋友"]')

  await plainPanel.getByRole('button', { name: '复制房间号' }).click()
  await expect(plainPanel.locator('.invite-status')).toHaveText('已选中，按 Ctrl/⌘ + C 复制')
  expect(await plain.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(roomId)

  await plainPanel.getByRole('button', { name: '复制邀请链接' }).click()
  await expect(plainPanel.locator('.invite-status')).toHaveText('已选中，按 Ctrl/⌘ + C 复制')
  const picked = await plain.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#invite-link')!
    return { start: input.selectionStart, end: input.selectionEnd, value: input.value }
  })
  expect(picked.value).toBe(link)
  expect([picked.start, picked.end], '链接应被整段选中，手按 Ctrl/⌘+C 就能复制').toEqual([0, link.length])

  expect(plainErrors).toEqual([])
  await plainContext.close()
})
