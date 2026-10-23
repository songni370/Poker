import { expect, test } from '@playwright/test'
import {
  createRoom,
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

test('结算展示：一人刷新不会影响全桌的赢家徽记状态', async ({ browser }) => {
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

  // 结算现在画在牌桌上：双方都应看到赢家徽记。
  await expect(a.locator('.win-badge').first()).toBeVisible()
  await expect(b.locator('.win-badge').first()).toBeVisible()

  // A 刷新页面（这一动作以前会让全桌重弹结算弹窗）
  await a.reload()
  await a.waitForURL(/\/table\//)
  await expect(a.getByText('已连接')).toBeVisible()
  await a.waitForTimeout(1500)

  /*
   * 刷新后：
   *   · A 应从快照恢复出同一手的赢家徽记（结算结果随快照下发）；
   *   · B 的徽记不受影响，且双方都不该弹出任何结算弹窗。
   */
  await expect(a.locator('.win-badge').first()).toBeVisible()
  await expect(b.locator('.win-badge').first()).toBeVisible()
  expect(
    await b.getByRole('button', { name: '知道了' }).isVisible().catch(() => false),
    'B 不应因为 A 刷新而弹出结算',
  ).toBe(false)
  expect(
    await a.getByRole('button', { name: '知道了' }).isVisible().catch(() => false),
    'A 刷新后也不应弹出结算',
  ).toBe(false)

  await aCtx.close()
  await bCtx.close()
})
