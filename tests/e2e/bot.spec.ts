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

  // ① 加机器人：按钮只在房主 + 未开局时出现。
  const addBot = host.getByTestId('add-bot-btn')
  await expect(addBot).toBeVisible()

  await addBot.click()
  // 服务端会广播「XXX（机器人）加入了牌桌」，座位随之多一个人。
  await expect
    .poll(async () => host.locator('.seat-slot article').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2)

  // 再加一个，凑成 3 人桌（更接近真实牌局，也验证可以加多个）。
  await addBot.click()
  await expect.poll(async () => host.locator('.seat-slot article').count(), { timeout: 10_000 }).toBe(3)

  // ② 开局：机器人会自己行动，不需要第二个浏览器。
  await startHand(host)

  /*
   * ③ 打完整手：playUntilSettled 会在轮到自己时点过牌/跟注，
   * 机器人则由服务端自动出牌——两边交替推进，直到结算叠层出现。
   */
  expect(await playUntilSettled([host], 60_000), '机器人与本人应能打完一手并结算').toBe(true)

  // 结算战报里应能读到结果（赢家 / 底池 / 全员弃牌 三种文案之一）。
  const settlement = host.getByRole('dialog').filter({ hasText: '战局结算战报' })
  await expect(settlement).toBeVisible()
  await expect(
    settlement.getByText(/恭喜获胜！赢得|赢得底池|全员弃牌，.+获胜|无人获胜/).first(),
  ).toBeVisible()

  expect(errors).toEqual([])
  await context.close()
})
