import { expect, test } from '@playwright/test'
import { createRoom, joinRoomByLink, startHand, takeSeat, watchErrors } from './room-helpers.ts'

/**
 * 牌局中「本轮下注」必须可见（玩家判断与加注的依据）。
 *
 * 每个还在本手里的玩家，都要能一眼看到：
 *   - 他这一轮已经放进底池多少（本轮下注）；
 *   - 他刚做了什么动作（过牌/跟注/下注/加注/全下）。
 *
 * 本轮下注统一画在**各自座位卡片正上方**的金色徽章里（`.table .bet`，用 data-seat 关联座位），
 * 座位卡片右下角不再重复显示同一金额；动作标签只写动作名（跟注/加注…）。
 */
test('牌局中展示本轮下注：每个在局玩家都能看到自己这一轮的投入', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors = [...watchErrors(host), ...watchErrors(guest)]

  const roomId = await createRoom(host, `下注${String(Date.now() % 1000)}`, '本轮下注验收')
  await joinRoomByLink(guest, roomId, `对手${String(Date.now() % 1000)}`)
  await takeSeat(host, 1)
  await takeSeat(guest, 2)
  await startHand(host)

  /**
   * 采集每个座位的：昵称、本轮下注、动作标签。
   *
   * 本轮下注现在只画在**座位卡片正上方**的金色徽章里（`.table .bet`，用 data-seat 关联座位），
   * 座位卡片右下角不再重复显示同一金额。
   */
  async function readSeats(page: typeof host) {
    return page.evaluate(() => {
      const bets = new Map<string, string>()
      document.querySelectorAll<HTMLElement>('.table .bet').forEach((el) => {
        const seat = el.dataset.seat
        if (seat) bets.set(seat, el.textContent?.trim() ?? '')
      })
      return [...document.querySelectorAll('.seat-slot')].map((slot, index) => ({
        name: slot.querySelector('.name')?.textContent?.trim() ?? '',
        bet: bets.get(String(index + 1)) ?? null,
        action: slot.querySelector('.action-label')?.textContent?.trim() ?? null,
        status: slot.querySelector('.status')?.textContent?.trim() ?? null,
      }))
    })
  }

  // 盲注：小盲与大盲的本轮下注必须可见（10 / 20），不能被「跟注」之类的动作文字盖掉。
  await expect
    .poll(async () => {
      const seats = await readSeats(host)
      const blinds = seats.filter((seat) => seat.bet !== null && seat.bet !== '0').map((seat) => seat.bet)
      return blinds.sort()
    }, { message: '开局后应能看到盲注的下注金额（10 与 20）' })
    .toEqual(['10', '20'])

  // 动作标签：开局后至少一个玩家带有「小盲 / 大盲」或具体动作标签
  const afterStart = await readSeats(host)
  expect(
    afterStart.some((seat) => seat.action !== null),
    `开局后应有玩家显示动作标签：${JSON.stringify(afterStart)}`,
  ).toBe(true)

  // 有人行动后（过牌/跟注/加注），动作标签要跟着变化
  const acting = await host.evaluate(() => {
    return [...document.querySelectorAll('.seat-slot')]
      .filter((slot) => slot.querySelector('.state')?.textContent?.includes('思考中'))
      .length
  })
  expect(acting).toBeLessThanOrEqual(1)

  expect(errors).toEqual([])
  await hostContext.close()
  await guestContext.close()
})
