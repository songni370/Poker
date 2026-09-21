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

test('聊天：房主发言对手能看到，刷新后仍能看到历史，未读数在按钮上可读', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `房主${Date.now() % 1000}`, 2)
  await joinRoom(guest, roomId, `客人${Date.now() % 1000}`)
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

  // 刷新后聊天历史仍在（服务端下发 chatHistory）
  await guest.reload()
  await guest.waitForURL(/\/table\//)
  await openDrawerSection(guest, '聊天')
  await expect(guest.getByText(text)).toBeVisible()

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
