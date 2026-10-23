import { expect, test } from '@playwright/test'
import {
  createRoom,
  joinRoomByLink,
  playUntilSettled,
  startHand,
  takeSeat,
  watchErrors,
} from './room-helpers.ts'

/**
 * 结算展示契约（设计已变更：不再弹窗，改为在牌桌上画赢家徽记）。
 *
 * 由来：把结算逻辑抽成 useHandResult 之后，曾出现「点知道了关不掉」——
 *   `<HandResultOverlay v-if="result">` 里 result 一直非空，组件不卸载，
 *   而 PrimeVue 的离场过渡被卡在中间态（DOM 上还留着 p-dialog-leave-active）。
 * 既有断言只检查「不误弹」，没检查「点了要真的关掉」，所以漏过了。
 *
 * 这里正面锁住三件事：
 *   ① 打完一手 → 叠层弹出，且展开的是「战局结算战报」；
 *   ② 点「知道了」→ 叠层从 DOM 里消失（不是只加个离场类）；
 *   ③ 刷新页面 → 本人已确认过的那一手不再弹。
 */
test('结算展示：赢家徽记画在牌桌上，不弹窗、刷新后仍能看到', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `结算${String(Date.now() % 1000)}`, '结算关闭验收')
  await joinRoomByLink(guest, roomId, `陪练${String(Date.now() % 1000)}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)

  expect(await playUntilSettled([host, guest])).toBe(true)

  /* ② 结算在牌桌上：赢家座位有王冠 + 赢得金额，且**没有**弹窗。 */
  const winBadges = host.locator('.win-badge')
  await expect(winBadges.first()).toBeVisible()
  await expect(winBadges.first()).toContainText(/\+\d+/)
  await expect(host.locator('.result-dialog')).toHaveCount(0)
  await expect(host.getByRole('button', { name: '知道了' })).toHaveCount(0)

  /* ③ 刷新后仍能读到这一手的结算（牌桌从快照恢复 lastResult，徽记照常显示）。 */
  await host.reload()
  await expect(host.locator('.table')).toBeVisible()
  await expect(host.locator('.win-badge').first()).toBeVisible()
  await expect(host.locator('.result-dialog')).toHaveCount(0)

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
