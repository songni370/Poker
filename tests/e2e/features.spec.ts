import { expect, test, type Page } from '@playwright/test'

/**
 * 体验与节奏功能的浏览器验收：
 *   1. 聊天：房主发言 → 对手在抽屉里看到；未读数可见；重连后仍能看到历史；
 *   2. 观战：座位满了仍能进来观战，看不到任何底牌、没有操作区，有人离座后可以入座。
 *
 * 全下逐张亮公共牌属于时序行为，由 tests/features.test.ts 在协议层断言（更稳定）。
 */

test.describe.configure({ mode: 'serial' })

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function createRoom(page: Page, nickname: string, maxSeats: number): Promise<string> {
  await page.goto('/')
  await page.getByPlaceholder('例如：小满').fill(nickname)
  // 座位数下拉：按可见文本选择
  await page.locator('.p-select, [role="combobox"]').first().click()
  await page.getByRole('option', { name: `${String(maxSeats)} 人桌` }).click()
  await page.getByRole('button', { name: '创建并进入等待区' }).click()
  await page.waitForURL(/\/room\//)
  return new URL(page.url()).pathname.split('/room/')[1]!
}

async function joinRoom(page: Page, roomId: string, nickname: string): Promise<void> {
  await page.goto(`/room/${roomId}`)
  await page.getByPlaceholder('例如：小满').fill(nickname)
  await page.getByRole('button', { name: '加入房间' }).click()
  await expect(page.getByText('座位', { exact: false }).first()).toBeVisible()
}

async function openDrawerSection(page: Page, name: '规则' | '历史' | '聊天'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
}

/** 双方只用过牌/跟注，保证走到摊牌。返回是否出现结算叠层。 */
async function playUntilSettled(pages: Page[], timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of pages) {
      if (await page.getByRole('button', { name: '知道了' }).isVisible().catch(() => false)) return true
      for (const pattern of [/^过牌/, /^跟注/]) {
        const button = page.getByRole('button', { name: pattern })
        if ((await button.count()) === 0) continue
        if (!(await button.first().isEnabled().catch(() => false))) continue
        await button.first().click()
        await page.waitForTimeout(120)
        break
      }
    }
    await pages[0]!.waitForTimeout(120)
  }
  return false
}

/** 关掉结算叠层，让底部与顶栏恢复可点。 */
async function dismissResult(page: Page): Promise<void> {
  const known = page.getByRole('button', { name: '知道了' })
  if (await known.isVisible().catch(() => false)) {
    await known.click()
    await known.waitFor({ state: 'hidden' })
  }
}

test('聊天：房主发言对手能看到，刷新后仍能看到历史，未读数在按钮上可读', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `房主${Date.now() % 1000}`, 2)
  const guestName = `客人${Date.now() % 1000}`
  await joinRoom(guest, roomId, guestName)
  await host.getByRole('button', { name: '开始牌局' }).click()
  await host.waitForURL(/\/table\//)
  await guest.waitForURL(/\/table\//)

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
  await guest.waitForTimeout(500) // 等抽屉滑入动画结束再截图
  await guest.screenshot({ path: 'artifacts/e2e/07-chat-drawer.png' })

  // 关掉抽屉后再来一条消息：重新打开时应出现「以下为新消息」分隔线
  await guest.locator('.p-drawer-close, [aria-label="Close"]').first().click().catch(() => guest.keyboard.press('Escape'))
  await guest.waitForTimeout(300)
  await host.getByPlaceholder('说点什么…').fill('第二条消息')
  await host.getByRole('button', { name: '发送' }).click()
  await guest.waitForTimeout(300)
  await openDrawerSection(guest, '聊天')
  await expect(guest.getByText('以下为新消息')).toBeVisible()
  await expect(guest.getByText('第二条消息')).toBeVisible()
  await guest.waitForTimeout(400)
  await guest.screenshot({ path: 'artifacts/e2e/09-chat-unread-divider.png' })

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
  await guest.screenshot({ path: 'artifacts/e2e/12-chat-mention-and-log.png' })

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
  const roomId = await createRoom(host, hostName, 2)
  await joinRoom(guest, roomId, guestName)
  await host.getByRole('button', { name: '开始牌局' }).click()
  await host.waitForURL(/\/table\//)
  await guest.waitForURL(/\/table\//)

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
  await host.screenshot({ path: 'artifacts/e2e/14-chat-grouping.png' })

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

  const roomId = await createRoom(host, `房主${Date.now() % 1000}`, 2)
  await joinRoom(guest, roomId, `客人${Date.now() % 1000}`)
  // 第三个人：座位已满 → 应以观战身份进入而不是报错
  await joinRoom(watcher, roomId, `观战${Date.now() % 1000}`)

  await host.getByRole('button', { name: '开始牌局' }).click()
  await host.waitForURL(/\/table\//)
  await guest.waitForURL(/\/table\//)
  await watcher.waitForURL(/\/table\//)

  // 观战者：能看到牌桌与观战面板，但没有操作区、没有底牌
  await expect(watcher.getByText('观战中')).toBeVisible()
  await expect(watcher.locator('.action-bar')).toHaveCount(0)
  await expect(watcher.locator('.hero-cards [role="img"]')).toHaveCount(0)
  // 对局进行中，观战者 DOM 里不应出现任何正面牌（背面牌不计）
  const faceUp = await watcher.locator('[role="img"]:not([aria-label="盖住的牌"])').count()
  expect(faceUp).toBe(0)
  await watcher.screenshot({ path: 'artifacts/e2e/08-spectator.png' })

  // 客人离座 → 观战者可以入座
  await guest.getByRole('button', { name: '退出' }).click()
  await guest.waitForURL(/\/room\//)
  await guest.getByRole('button', { name: '离座' }).click()

  // 空位出现后，观战面板应给出可选座位（不再只能坐第一个）
  await expect(watcher.getByRole('group', { name: '选择座位' })).toBeVisible({ timeout: 10_000 })
  await watcher.screenshot({ path: 'artifacts/e2e/10-spectator-seat-picker.png' })

  const seatButton = watcher.getByRole('button', { name: '入座' })
  await expect(seatButton).toBeEnabled({ timeout: 10_000 })
  await seatButton.click()
  await expect(watcher.getByText('观战中')).toBeHidden({ timeout: 10_000 })

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

  const roomId = await createRoom(host, `收纳${String(Date.now() % 1000)}`, 2)
  await joinRoom(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await host.getByRole('button', { name: '开始牌局' }).click()
  await host.waitForURL(/\/table\//)

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
  await host.screenshot({ path: 'artifacts/e2e/11-bar-more-menu.png' })
  await menu.first().getByText(/^聊天/).first().click()
  await expect(host.getByPlaceholder('说点什么…')).toBeVisible()

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})

/**
 * 观战选座在窄屏必须保持「一排」：9 人桌最多 8 个空位，换行会把底部区域撑成两行，
 * 牌桌被挤掉一截。这里验证 390×844 竖屏下 8 个座位按钮同排（可横向滚动），
 * 并且不产生横向页面溢出。
 */
test('观战选座：9 人桌 8 个空位在窄屏仍是一排，不换行也不横向溢出', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `选座${String(Date.now() % 1000)}`, 9)
  await joinRoom(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await host.getByRole('button', { name: '开始牌局' }).click()
  await host.waitForURL(/\/table\//)
  await guest.waitForURL(/\/table\//)

  // 先把这一手打完：手牌进行中离座的玩家要等本手结束才真正离开座位（筹码还在池里），
  // 那时才能重新入座，所以观战选座要在结算之后验证。
  expect(await playUntilSettled([host, guest])).toBe(true)

  // 客人离座（等待区）后回到牌桌 → 成为观战者，9 人桌只剩 1 个座位被占
  await dismissResult(guest)
  await guest.getByRole('button', { name: '退出' }).click()
  await guest.waitForURL(/\/room\//)
  await guest.getByRole('button', { name: '离座' }).click()
  await guest.goto(`/table/${roomId}`)
  await expect(guest.getByText('观战中')).toBeVisible({ timeout: 10_000 })
  // 快照里仍带着上一手的结算结果，重新进桌会再弹一次结算叠层（模态遮罩会挡住选座按钮）。
  await dismissResult(guest)

  await guest.setViewportSize({ width: 390, height: 844 })
  await guest.waitForTimeout(300)

  const picker = guest.getByRole('group', { name: '选择座位' })
  await expect(picker).toBeVisible()
  const buttons = picker.getByRole('button')
  await expect(buttons).toHaveCount(8)

  const boxes = await picker.locator('.p-button').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) }
    }),
  )
  // 同排：所有按钮的纵向位置一致（换行会让 top 出现第二个值）
  expect(new Set(boxes.map((box) => box.top)).size, `座位按钮应排在同一行：${JSON.stringify(boxes)}`).toBe(1)
  // 触控目标不被压小
  boxes.forEach((box) => {
    expect(box.width).toBeGreaterThanOrEqual(40)
    expect(box.height).toBeGreaterThanOrEqual(32)
  })

  // 容器是一排（可横向滚动），并且整页不横向溢出
  const layout = await guest.evaluate(() => {
    const list = document.querySelector('.seat-picker')
    const seatRow = document.querySelector('.spectator-seat-picker')
    return {
      wrap: list ? getComputedStyle(list).flexWrap : '',
      scrollable: list ? list.scrollWidth > list.clientWidth : false,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rowHeight: Math.round(seatRow?.getBoundingClientRect().height ?? 0),
    }
  })
  expect(layout.wrap).toBe('nowrap')
  expect(layout.scrollable).toBe(true)
  expect(layout.overflowX).toBe(0)
  // 一排的高度：按钮 40px + 内边距，远小于换行后的两排
  expect(layout.rowHeight).toBeLessThan(64)
  await guest.screenshot({ path: 'artifacts/e2e/15-spectator-seat-picker-narrow.png' })

  // 仍然可以按座位号入座
  await buttons.nth(4).click()
  await expect(guest.getByText('观战中')).toBeHidden({ timeout: 10_000 })

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
