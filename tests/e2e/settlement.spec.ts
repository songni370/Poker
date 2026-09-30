import { expect, test } from '@playwright/test'
import {
  createRoom,
  dismissResult,
  joinRoomByLink,
  playUntilSettled,
  startHand,
  takeSeat,
} from './room-helpers.ts'

/**
 * 结算叠层的回归用例（真实 bug：一个人刷新页面，全桌所有人都会再弹一次结算）。
 *
 * 成因：TableView 里两个 watch 的 getter 返回数组，Vue 每次比较都是新数组，
 * 于是任何状态广播（别人加入 / 断线 / 重连）都会把「已确认结算」重置并重开叠层。
 * 现在 getter 返回字符串，并且本人确认过的 handId 记在 sessionStorage，刷新后不再弹。
 */

/**
 * 结算叠层的回归用例（真实 bug：一个人刷新页面，全桌所有人都会再弹一次结算）。
 *
 * 成因：TableView 里两个 watch 的 getter 返回数组，Vue 每次比较都是新数组，
 * 于是任何状态广播（别人加入 / 断线 / 重连）都会把「已确认结算」重置并重开叠层。
 * 现在 getter 返回字符串，并且本人确认过的 handId 记在 sessionStorage，刷新后不再弹。
 */

test('结算叠层：一人刷新不会让全桌重弹，本人已确认过的那一手刷新后也不再弹', async ({ browser }) => {
  test.setTimeout(120_000)
  const aCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const bCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const a = await aCtx.newPage()
  const b = await bCtx.newPage()

  const roomId = await createRoom(a, '刷新A', '刷新复现')
  await joinRoomByLink(b, roomId, '旁观B')
  await takeSeat(a, 1)
  await takeSeat(b, 2)
  await startHand(a)
  expect(await playUntilSettled([a, b])).toBe(true)

  // 双方都确认过结算，此时任何状态广播都不该重开叠层
  await dismissResult(a)
  await dismissResult(b)

  // A 刷新页面
  await a.reload()
  await a.waitForURL(/\/table\//)
  await expect(a.getByText('已连接')).toBeVisible()
  await a.waitForTimeout(1500)

  const aVisible = await a.getByRole('button', { name: '知道了' }).isVisible().catch(() => false)
  const bVisible = await b.getByRole('button', { name: '知道了' }).isVisible().catch(() => false)
  expect(bVisible, 'B 不应因为 A 刷新而再弹结算叠层').toBe(false)
  expect(aVisible, 'A 刷新前已确认过这一手，刷新后也不应再弹').toBe(false)

  await aCtx.close()
  await bCtx.close()
})
