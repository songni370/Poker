import { expect, test } from '@playwright/test'
import { createRoom, playUntilSettled, startHand, takeSeat, watchErrors } from './room-helpers.ts'

/**
 * 机器人陪练：一个人也能把整条流程跑通。
 *
 * 覆盖的是「能加、能打、能结算」三件事：
 *   ① 房主点「加机器人」→ 座位上出现机器人（服务端广播）；
 *   ② 机器人自己会入座并参与牌局（不需要第二个人）；
 *   ③ 打完一手能正常结算——说明机器人的出牌走的是和真人一样的规则路径。
 *
 * 机器人跑在服务端进程内（没有 WebSocket），所以这个用例只需要**一个**浏览器上下文，
 * 这正是它的价值：以前半张 e2e 都要开两个上下文才能验证对局流程。
 */
test('机器人陪练：单人加机器人后能自动打完一手并结算', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const host = await context.newPage()
  const errors = watchErrors(host)

  const roomId = await createRoom(host, `单人${String(Date.now() % 1000)}`, '机器人验收')
  expect(roomId).toMatch(/^[1-9]\d{5}$/)

  await takeSeat(host, 1)

  /*
   * ① 加机器人：入口在房主的「配置」弹窗里（不放操作区，
   *    免得把手机上本来就挤的一排按钮再撑宽）。
   */
  await host.getByRole('button', { name: '牌局配置' }).click()
  const configDialog = host.getByRole('dialog').filter({ hasText: '机器人陪练' })
  await expect(configDialog).toBeVisible()

  const addBalanced = host.getByTestId('add-bot-balanced')
  await expect(addBalanced).toBeVisible()

  await addBalanced.click()
  // 服务端会广播「XXX（机器人）加入了牌桌」，座位随之多一个人。
  await expect
    .poll(async () => host.locator('.seat-slot article').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2)

  // 再加一个（换成「紧手」性格，验证性格可切换），凑成 3 人桌。
  await host.getByTestId('add-bot-tight').click()
  await expect.poll(async () => host.locator('.seat-slot article').count(), { timeout: 10_000 }).toBe(3)

  // 关掉配置弹窗再开局。
  await host.getByRole('button', { name: '取消' }).click()
  await expect(configDialog).toBeHidden()

  // ② 开局：机器人会自己行动，不需要第二个浏览器。
  await startHand(host)

  /*
   * ③ 打完整手：playUntilSettled 会在轮到自己时点过牌/跟注，
   * 机器人则由服务端自动出牌——两边交替推进，直到结算叠层出现。
   */
  expect(await playUntilSettled([host], 60_000), '机器人与本人应能打完一手并结算').toBe(true)

  /*
   * 结算展示在牌桌上：赢家座位出现王冠 + 赢得金额（不再弹窗）。
   * 至少要有一个人拿到徽记；徽记里应带「+数字」。
   */
  const winBadges = host.locator('.win-badge')
  await expect(winBadges.first()).toBeVisible()
  await expect(winBadges.first()).toContainText(/\+\d+/)
  // 王冠与金币特效也在（纯 CSS，不需要素材）。
  await expect(host.locator('.win-crown').first()).toBeAttached()
  // 确认没有再弹旧的结算弹窗。
  await expect(host.locator('.result-dialog')).toHaveCount(0)

  expect(errors).toEqual([])
  await context.close()
})
