import { expect, test, type Page } from '@playwright/test'

/**
 * 结算叠层的回归用例（真实 bug：一个人刷新页面，全桌所有人都会再弹一次结算）。
 *
 * 成因：TableView 里两个 watch 的 getter 返回数组，Vue 每次比较都是新数组，
 * 于是任何状态广播（别人加入 / 断线 / 重连）都会把「已确认结算」重置并重开叠层。
 * 现在 getter 返回字符串，并且本人确认过的 handId 记在 sessionStorage，刷新后不再弹。
 */

async function settle(pages: Page[], timeoutMs = 40_000): Promise<boolean> {
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

test('结算叠层：一人刷新不会让全桌重弹，本人已确认过的那一手刷新后也不再弹', async ({ browser }) => {
  test.setTimeout(120_000)
  const aCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const bCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const a = await aCtx.newPage()
  const b = await bCtx.newPage()

  await a.goto('/')
  await a.getByPlaceholder('例如：小满').fill('刷新A')
  await a.getByPlaceholder('例如：周五夜局').fill('刷新复现')
  await a.getByRole('button', { name: '创建并进入等待区' }).click()
  await a.waitForURL(/\/room\//)
  const roomId = new URL(a.url()).pathname.split('/room/')[1]!

  await b.goto(`/room/${roomId}`)
  await b.getByPlaceholder('例如：小满').fill('旁观B')
  await b.getByRole('button', { name: '加入房间' }).click()
  await expect(b.getByText('座位', { exact: false }).first()).toBeVisible()

  await a.getByRole('button', { name: '开始牌局' }).click()
  await a.waitForURL(/\/table\//)
  await b.waitForURL(/\/table\//)
  expect(await settle([a, b])).toBe(true)

  // 两边都关掉结算叠层
  for (const [name, page] of [['A', a], ['B', b]] as const) {
    const known = page.getByRole('button', { name: '知道了' })
    if (await known.isVisible().catch(() => false)) await known.click()
    await expect(known, `${name} 关闭后不应可见`).toBeHidden()
  }
  // 双方都确认过结算，此时任何状态广播都不该重开叠层

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
