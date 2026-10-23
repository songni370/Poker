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
 * 结算叠层的「关闭」与「刷新不重弹」两条契约。
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
test('结算叠层：点「知道了」真的关闭，刷新后也不再弹', async ({ browser }) => {
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

  const settlement = host.getByRole('dialog').filter({ hasText: '战局结算战报' })
  await expect(settlement).toBeVisible()

  /* ② 点「知道了」：叠层必须从 DOM 里消失。
   * 只断言「不可见」会漏掉「还挂在 DOM 上、带着 leave-active 类但 display 仍是 flex」
   * 的半关闭状态——那正是 v-if 只判断 result 时踩到的坑。 */
  await host.getByRole('button', { name: '知道了' }).click()
  await expect(host.locator('.p-dialog.result-dialog')).toHaveCount(0, { timeout: 8_000 })

  /* ③ 刷新：本人已确认过的这一手不再弹。
   * 依赖 useHandResult 写进 sessionStorage 的「已确认 handId」，key 按房间隔离。 */
  await host.reload()
  await expect(host.locator('.table')).toBeVisible()
  // 给结算广播与 watch 一点时间跑完，再确认没有弹层。
  await host.waitForTimeout(1200)
  await expect(host.locator('.result-dialog')).toHaveCount(0)
  await expect(host.getByRole('button', { name: '知道了' })).toHaveCount(0)

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
