// 牌桌端到端测试的公用流程（第 5/6 项需求改版后的新流程）。
//
// 新流程与旧版最大的区别：**没有等候页**。
//   建房 / 加入邀请链接 → 直接落在 /table/:roomId，此时是旁观者（没有座位）
//   → 点桌面上的空位 → 确认买入 → 落座（下一手开始就参与）
//   → 「离座」只保留座位与筹码，「退出房间」才释放座位。
import { expect, type Page } from '@playwright/test'

/** 收集页面未捕获异常与 console.error，用例结束断言为空。 */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

/**
 * 大厅建房：填昵称（可选房间名 / 初始筹码 / 买入上限）→ 直接进牌桌（还没落座）。返回房间号。
 *
 * 产品固定 9 人桌，大厅不再有「座位数」选项：`options.maxSeats` 仅为兼容旧调用保留、**忽略**。
 */
export async function createRoom(
  page: Page,
  nickname: string,
  roomName?: string,
  options: { maxSeats?: number; minBuyIn?: number; buyInMax?: number; password?: string } = {},
): Promise<string> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '开一桌德州' })).toBeVisible()
  const createTab = page.getByRole('tab', { name: '创建房间' })
  if (await createTab.isVisible().catch(() => false)) {
    await createTab.click()
  }
  await page.getByPlaceholder('例如：小满').fill(nickname)
  await page.locator('#create-room-password').fill(options.password ?? '123456')
  if (roomName) await page.getByPlaceholder('例如：周五夜局').fill(roomName)
  if (options.minBuyIn !== undefined) {
    const input = page.locator('#min-buy-in')
    await input.fill(String(options.minBuyIn))
    await input.blur()
  }
  if (options.buyInMax !== undefined) {
    const input = page.locator('#buy-in-max')
    await input.fill(String(options.buyInMax))
    await input.blur()
  }
  await page.getByRole('button', { name: '创建牌桌' }).click()
  await page.waitForURL(/\/table\//)
  await expect(page.locator('.table')).toBeVisible()
  const roomId = new URL(page.url()).pathname.split('/table/')[1]!
  // 房间号是纯数字 6 位（首位非 0）：邀请链接里那串就是它。
  expect(roomId).toMatch(/^[1-9]\d{5}$/)
  return roomId
}

/** 邀请链接落地页：填昵称 → 进入牌桌（旁观，未落座）。 */
export async function joinRoomByLink(page: Page, roomId: string, nickname: string, password = '123456'): Promise<void> {
  await page.goto(`/table/${roomId}`)
  await expect(page.getByRole('heading', { name: /加入/ })).toBeVisible()
  await page.getByPlaceholder('例如：小满').fill(nickname)
  await page.locator('#invite-password').fill(password)
  await page.getByRole('button', { name: '进入牌桌' }).click()
  await expect(page.locator('.table')).toBeVisible()
  await expect(page.getByText('观战中')).toBeVisible()
}

/**
 * 点某个空位并确认买入（不传金额就用弹窗默认值 = 本桌买入上限）。
 *
 * 幂等：已经坐好了就直接返回。买入是本地弹窗 → 服务端确认的异步过程，点击「确认买入」与
 * 弹窗关闭之间存在竞态——实测出现过「座位已经坐好、Playwright 仍在等那个按钮可点」，
 * 一路重试到 90s 用例超时（第 3 项需求改版后新增的用例就踩到了）。先看状态再点，两条路都成立。
 */
export async function takeSeat(page: Page, seatNumber: number, buyIn?: number): Promise<void> {
  if (await page.locator('.hero-cards').isVisible().catch(() => false)) return
  await page.getByRole('button', { name: `坐到 ${String(seatNumber)} 号座位` }).first().click()
  const dialog = page.locator('.p-dialog')
  await expect(dialog).toBeVisible()
  if (buyIn !== undefined) {
    const input = dialog.locator('input').first()
    await input.fill(String(buyIn))
    await input.blur()
  }
  // 点确认也是幂等的：弹窗可能已经被服务端广播关掉（此时 click 会抛超时），忽略即可。
  const confirm = dialog.getByRole('button', { name: '确认买入' })
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click({ timeout: 5000 }).catch(() => undefined)
  }
  // 落座后底部出现「你的底牌」区（观战/离座面板消失）
  await expect(page.locator('.hero-cards')).toBeVisible()
}

/** 第 N 个空位（1 起算）落座：适合「随便挑一个空位」的用例。 */
export async function takeAnyFreeSeat(page: Page, index = 0, buyIn?: number): Promise<void> {
  const button = page.locator('.seat-empty').nth(index)
  await expect(button).toBeVisible()
  const label = (await button.getAttribute('aria-label')) ?? ''
  const seatNumber = Number(/坐到 (\d+) 号座位/.exec(label)?.[1] ?? '0')
  expect(seatNumber).toBeGreaterThan(0)
  await takeSeat(page, seatNumber, buyIn)
}

/**
 * 主持人开局（第一手叫「开始牌局」，之后叫「开始下一手」）。
 * 点完必须等它消失：牌局进行中这个按钮是隐藏的，等它隐藏就等于「本手真的开了」，
 * 否则紧接着读底牌会读到开局前的快照。
 */
export async function startHand(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /^开始(牌局|下一手)$/ }).first()
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toBeHidden({ timeout: 15_000 })
}

/** 离座（保留座位与筹码）：本手仍在牌局中时会弹确认框。 */
export async function leaveSeat(page: Page): Promise<void> {
  await page.getByRole('button', { name: '离座', exact: true }).first().click()
  const confirm = page.getByRole('button', { name: '离座并弃牌' })
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  // 用离座面板里的标题判定（页面上的提示/聊天日志里也会出现「已离座」字样）
  await expect(page.locator('.spectator-state')).toContainText('已离座')
}

/** 退出房间（释放座位）：顶栏与面板上都有入口，确认框里再点一次。 */
export async function exitRoom(page: Page): Promise<void> {
  const entry = page.getByRole('button', { name: /退出房间|^退出$/ }).first()
  await entry.click()
  await page.getByRole('button', { name: '退出房间', exact: true }).last().click()
  await page.waitForURL((url) => !url.pathname.startsWith('/table/'))
}

/** 打开牌桌右侧抽屉的某个分节（规则 / 历史 / 聊天）。 */
export async function openDrawerSection(page: Page, name: '规则' | '历史' | '聊天'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
}

/** 双方只用过牌/跟注，保证走到摊牌。返回是否出现结算叠层。 */
export async function playUntilSettled(pages: Page[], timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of pages) {
      if (await page.getByRole('button', { name: '知道了' }).isVisible().catch(() => false)) return true
      // 动作按钮改成「英文主 + 中文辅」后，可访问名称是「CHECK 过牌」/「CALL 跟注 20」，
      // 所以这里不能再锚定开头，只按中文子串匹配。
      for (const pattern of [/过牌/, /跟注/]) {
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
export async function dismissResult(page: Page): Promise<void> {
  const known = page.getByRole('button', { name: '知道了' })
  if (await known.isVisible().catch(() => false)) {
    await known.click()
    await known.waitFor({ state: 'hidden' })
  }
}

/** 读取某页面「你的底牌」区域里的牌面（PlayingCard 用 role=img + aria-label）。 */
export async function readHoleCards(page: Page): Promise<string[]> {
  const cards = page.locator('.hero-cards [role="img"]')
  const count = await cards.count()
  const labels: string[] = []
  for (let index = 0; index < count; index++) {
    const label = await cards.nth(index).getAttribute('aria-label')
    if (label && label !== '盖住的牌') labels.push(label)
  }
  return labels
}
