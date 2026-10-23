// 牌桌 composable 的单测（不依赖浏览器，只用 effectScope 提供响应式作用域）。
//
// 为什么单独测这些：它们是从 4500 行的 TableView.vue 里抽出来的判定逻辑，
// 而下面这些都是**真实踩过的坑**，靠 e2e 未必能覆盖：
//   · useSeatOverview 的判据曾用 self.seat，观战者也有 self —— 桌面一个空位都不画；
//   · useHandResult 的 watch getter 曾返回数组，导致任何广播都重弹结算；
//   · useTurnTimer 的 rAF 循环在 deadline 变化时没重置，读数会跳；
//   · useHudPanels 的三块面板互斥展开，漏一处就会出现两块同时展开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import { useSeatOverview } from '../src/client/composables/useSeatOverview.ts'
import { useHandResult } from '../src/client/composables/useHandResult.ts'
import { useHudPanels } from '../src/client/composables/useHudPanels.ts'
import { useChatStore } from '../src/client/stores/chat.ts'
import { useTableCommands } from '../src/client/composables/useTableCommands.ts'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 最小 sessionStorage 桩：Node 里没有浏览器存储。
 * useHandResult 用 sessionStorage 记「已确认过的 handId」，这里用一个 Map 顶替，
 * 既让逻辑能跑，也能在用例里断言「确实写进去了」。
 */
class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}
const storage = new MemoryStorage()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = storage

/** 跑一次 composable：给个独立作用域，测完自动 stop，避免 watcher 泄漏到其他用例。 */
function inScope<T>(factory: () => T): { value: T; stop: () => void } {
  const scope = effectScope()
  const value = scope.run(factory)!
  return { value, stop: () => scope.stop() }
}

/* ───────────── 座位概况 ───────────── */

test('座位概况：已入座数与空位数按实际座位算，满员时不能再坐', () => {
  const seats = [{ playerId: 'a' }, null, { playerId: 'b' }, null]
  const { value } = inScope(() =>
    useSeatOverview({
      seats: () => seats as never,
      maxSeats: () => 9,
      isSeated: () => false,
      hasSelf: () => true,
    }),
  )
  assert.equal(value.occupiedCount.value, 2)
  assert.equal(value.maxSeats.value, 9)
  assert.equal(value.emptyCount.value, 7)
  assert.equal(value.isTableFull.value, false)
  // 首个空位是 1 号（0 起），不是 0 号——0 号已经有人。
  assert.equal(value.firstAvailableSeat.value, 1)
  assert.equal(value.canSitDown.value, true)
})

test('座位概况：满员时 canSitDown 为 false，首个空位为 null', () => {
  const seats = Array.from({ length: 9 }, (_, i) => ({ playerId: `p${String(i)}` }))
  const { value } = inScope(() =>
    useSeatOverview({
      seats: () => seats as never,
      maxSeats: () => 9,
      isSeated: () => false,
      hasSelf: () => true,
    }),
  )
  assert.equal(value.emptyCount.value, 0)
  assert.equal(value.isTableFull.value, true)
  assert.equal(value.firstAvailableSeat.value, null)
  assert.equal(value.canSitDown.value, false)
})

test('座位概况：已在座 / 无身份时不能入座（观战者才有 self，不能拿它当「在座」）', () => {
  const seats = [null, null]
  const seated = inScope(() =>
    useSeatOverview({
      seats: () => seats as never,
      maxSeats: () => 9,
      isSeated: () => true,
      hasSelf: () => true,
    }),
  )
  // 在座的人不该看到「入座」入口。
  assert.equal(seated.value.canSitDown.value, false)

  const anonymous = inScope(() =>
    useSeatOverview({
      seats: () => seats as never,
      maxSeats: () => 9,
      isSeated: () => false,
      hasSelf: () => false,
    }),
  )
  // 还没有房间身份（未加入）时也不能入座。
  assert.equal(anonymous.value.canSitDown.value, false)
})

test('座位概况：服务端未下发的 maxSeats 退化为 0，而不是负数空位', () => {
  const { value } = inScope(() =>
    useSeatOverview({
      seats: () => [] as never,
      maxSeats: () => undefined,
      isSeated: () => false,
      hasSelf: () => true,
    }),
  )
  assert.equal(value.maxSeats.value, 0)
  assert.equal(value.emptyCount.value, 0)
  assert.equal(value.firstAvailableSeat.value, null)
  assert.equal(value.canSitDown.value, false)
})

/* ───────────── 结算叠层 ───────────── */

/** 造一个最小的结算结果（只用到 handId）。 */
function makeResult(handId: string) {
  return {
    handId,
    handNo: 1,
    board: [],
    potTotal: 30,
    showdown: false,
    winners: [],
    revealed: [],
  }
}

test('结算展示：不再弹窗——结果由牌桌上的赢家徽记表达', async () => {
  /*
   * 设计变更（用户要求）：结算不再用弹窗，改为在赢家座位上画王冠 + 金额 + 金币特效。
   * 所以 overlayVisible 必须恒为 false，即使已经进入结算阶段、有结算结果。
   * 这条用例守的就是「不要哪天又悄悄把弹窗塞回来」。
   */
  const handNo = ref(1)
  const phase = ref<string>('settlement')
  const lastResult = ref<ReturnType<typeof makeResult> | null>(makeResult('h-1'))
  const heroCards = ref([])

  const { value } = inScope(() =>
    useHandResult({
      roomId: () => 'room-no-overlay',
      lastResult: () => lastResult.value,
      handNo: () => handNo.value,
      phase: () => phase.value,
      heroCards: () => heroCards.value,
    }),
  )

  assert.equal(value.overlayVisible.value, false, '结算阶段也不应弹窗')
  // 但 result 仍然可读——牌桌用它算赢家金额与王冠。
  assert.ok(value.result.value, '结算结果本身仍要能拿到，供牌桌渲染赢家徽记')
})

test('结算展示：换到下一手后 result 会切换（赢家徽记跟着换人）', async () => {
  const handNo = ref(1)
  const phase = ref<string>('settlement')
  const lastResult = ref<ReturnType<typeof makeResult> | null>(makeResult('h-1'))
  const heroCards = ref([])

  const { value } = inScope(() =>
    useHandResult({
      roomId: () => 'room-next-hand',
      lastResult: () => lastResult.value,
      handNo: () => handNo.value,
      phase: () => phase.value,
      heroCards: () => heroCards.value,
    }),
  )
  assert.equal(value.result.value?.handId, 'h-1')

  // 下一手结算：牌桌读到的 result 必须换成新的一手。
  handNo.value = 2
  lastResult.value = makeResult('h-2')
  await nextTick()
  assert.equal(value.result.value?.handId, 'h-2')
  assert.equal(value.overlayVisible.value, false)
})

test('结算叠层：局末底牌被清空时，展示回退到本手缓存', async () => {
  sessionStorage.clear()
  const heroCards = ref<{ rank: string; suit: string }[]>([])
  const { value } = inScope(() =>
    useHandResult({
      roomId: () => 'room-cards',
      lastResult: () => null,
      handNo: () => 1,
      phase: () => 'flop',
      heroCards: () => heroCards.value as never,
    }),
  )

  assert.deepEqual(value.activeHeroCards.value, [])
  // 发到本人底牌：缓存住。
  heroCards.value = [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 'h' },
  ]
  await nextTick()
  assert.equal(value.activeHeroCards.value.length, 2)

  // 局末快照把底牌清空：结算叠层仍要能看到这手牌。
  heroCards.value = []
  await nextTick()
  assert.equal(value.activeHeroCards.value.length, 2, '底牌被清空时应回退到本手缓存')
})

/* ───────────── HUD 浮层面板 ───────────── */

/** 每个用例一套干净的 Pinia，避免 chat store 的消息在用例间串味。 */
function freshPinia(): void {
  setActivePinia(createPinia())
}

/**
 * 往 chat store 里追加消息（不经过网络）。
 *
 * 用 `append` 而不是 `setHistory`：只有 `append` 会推进未读计数，
 * 这正是「别人发言 → 按钮上出现未读数」的真实路径。
 */
function pushMessages(count: number, startAt = 0): void {
  const chat = useChatStore()
  for (let i = startAt; i < startAt + count; i += 1) {
    chat.append({
      id: `m-${String(i)}`,
      kind: 'user',
      playerId: `p-${String(i % 2)}`,
      nickname: `玩家${String(i % 2)}`,
      text: `消息 ${String(i)}`,
      at: Date.now(),
      mentions: [],
    })
  }
}

test('HUD 面板：三块浮层互斥展开，同一时刻最多开一个', async () => {
  freshPinia()
  const { value } = inScope(() =>
    useHudPanels({ sendChat: () => true, heroPlayerId: () => 'me' }),
  )

  // 初始全收起。
  assert.deepEqual([value.chatOpen.value, value.scoreOpen.value, value.historyOpen.value], [false, false, false])

  value.toggleChat()
  await nextTick()
  assert.equal(value.chatOpen.value, true)
  assert.equal(value.scoreOpen.value, false)

  // 开计分板 → 聊天自动收起。
  value.toggleScore()
  await nextTick()
  assert.equal(value.chatOpen.value, false)
  assert.equal(value.scoreOpen.value, true)
  assert.equal(value.historyOpen.value, false)

  // 开历史 → 计分板自动收起。
  value.toggleHistory()
  await nextTick()
  assert.equal(value.chatOpen.value, false)
  assert.equal(value.scoreOpen.value, false)
  assert.equal(value.historyOpen.value, true)

  // 再点一次历史 → 收起（不是重开）。
  value.toggleHistory()
  await nextTick()
  assert.equal(value.historyOpen.value, false)
})

test('HUD 面板：关闭聊天时记录已读锚点，重新打开后之后的消息才算新消息', async () => {
  freshPinia()
  const { value } = inScope(() =>
    useHudPanels({ sendChat: () => true, heroPlayerId: () => 'me' }),
  )
  pushMessages(3)
  await nextTick()

  // 打开聊天：清未读，锚点保持 null（此前从没打开过）。
  value.toggleChat()
  await nextTick()
  assert.equal(value.chat.unread, 0)

  // 关闭聊天：记下锚点 = 当前 3 条。
  value.toggleChat()
  await nextTick()
  assert.equal(value.chat.readAnchorCount, 3)

  // 关闭期间来了 2 条：打开后应能标出「以下为新消息」。
  pushMessages(2, 3)
  await nextTick()
  assert.equal(value.chat.unread, 2)

  value.toggleChat()
  await nextTick()
  assert.equal(value.chat.unread, 0, '打开面板应清未读')
  assert.equal(value.chat.readAnchorCount, 3, '锚点不该被打开动作改动')
  assert.ok(value.chat.firstUnreadId, '应能定位到未读起点')
})

test('HUD 面板：点外部空白收起面板；收聊天时同样记已读锚点', async () => {
  freshPinia()
  const { value } = inScope(() =>
    useHudPanels({ sendChat: () => true, heroPlayerId: () => 'me' }),
  )
  pushMessages(2)
  await nextTick()

  value.toggleChat()
  await nextTick()
  assert.equal(value.chatOpen.value, true)

  // 点面板外部：收聊天并记锚点。
  const outside = { closest: () => null } as unknown as HTMLElement
  value.handleOutsidePointer({ target: outside } as unknown as PointerEvent, {
    chat: '.hud-chat-anchor',
    score: '.hud-score-anchor',
    history: '.hud-history-anchor',
  })
  await nextTick()
  assert.equal(value.chatOpen.value, false)
  assert.equal(value.chat.readAnchorCount, 2)
})

test('HUD 面板：聊天发送成功才清空草稿，失败保留输入', async () => {
  freshPinia()
  let online = true
  const { value } = inScope(() =>
    useHudPanels({ sendChat: () => online, heroPlayerId: () => 'me' }),
  )

  value.draft.value = '你好'
  value.submitChat()
  await nextTick()
  assert.equal(value.draft.value, '')
  assert.equal(value.error.value, '')

  // 断线：消息发不出去，草稿必须留着，否则用户白打一行字。
  online = false
  value.draft.value = '再来一条'
  value.submitChat()
  await nextTick()
  assert.equal(value.draft.value, '再来一条')
  assert.match(value.error.value, /未连接/)
})

/* ───────────── 牌桌命令 ───────────── */

/** 记录发出的命令，并按需返回在线/离线。 */
function makeCommandHarness(initial: { seat: number | null; stack: number; away: boolean }) {
  const sent: { type: string; [key: string]: unknown }[] = []
  const announced: string[] = []
  let online = true
  const state = {
    seat: initial.seat as number | null,
    stack: initial.stack,
    away: initial.away,
  }
  const commands = inScope(() =>
    useTableCommands({
      sendCommand: (command) => {
        if (!online) return false
        sent.push(command as { type: string })
        return true
      },
      nextRequestId: () => 'req-1',
      announce: (text) => {
        announced.push(text)
      },
      state: () => ({
        handId: 'h-1',
        version: 3,
        phase: 'preflop',
        handNo: 1,
        buyInMin: 2000,
        buyInMax: 5000,
        buyInStep: 10,
      }),
      mySeat: () =>
        state.seat === null
          ? null
          : ({
              away: state.away,
              inHand: true,
              folded: false,
              stack: state.stack,
              committedStreet: 10,
            } as never),
      selfSeat: () => state.seat,
      isHost: () => true,
      isOnline: () => online,
      members: () => [],
      onExitRoom: () => {},
    }),
  )
  return {
    value: commands.value,
    sent,
    announced,
    state,
    setOnline: (next: boolean) => {
      online = next
    },
  }
}

test('牌桌命令：已离座且筹码 > 0 时点空位直接坐下，不弹买入', async () => {
  const h = makeCommandHarness({ seat: 2, stack: 3500, away: true })
  assert.equal(h.value.canPickSeat.value, true, '离座者应在桌面上看到可选空位')

  h.value.pickSeat(5)
  await nextTick()

  // 直接发 seat.take，把原筹码带过去；不该打开买入弹窗。
  assert.equal(h.value.buyInOpen.value, false)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.type, 'seat.take')
  assert.equal(h.sent[0]?.buyIn, 3500, '筹码应原样带回')
})

test('牌桌命令：输光（筹码为 0）的离座者必须走买入弹窗', async () => {
  const h = makeCommandHarness({ seat: 2, stack: 0, away: true })
  h.value.pickSeat(5)
  await nextTick()
  assert.equal(h.value.buyInOpen.value, true, '筹码为 0 时应弹买入')
  assert.equal(h.sent.length, 0)
})

test('牌桌命令：观战者点空位弹买入，确认后按步进取整再发送', async () => {
  const h = makeCommandHarness({ seat: null, stack: 0, away: false })
  assert.equal(h.value.canPickSeat.value, true, '旁观者应能在桌面上挑座位')

  h.value.pickSeat(3)
  await nextTick()
  assert.equal(h.value.buyInOpen.value, true)

  // 传入一个非整步进的金额：composable 只负责发命令，取整由 BuyInDialog 做，
  // 这里验证「原样透传」这条契约（取整逻辑在组件的 input step 上）。
  h.value.confirmBuyIn(5000)
  await nextTick()
  assert.equal(h.value.buyInOpen.value, false, '确认后应关闭弹窗')
  assert.equal(h.sent[0]?.type, 'seat.take')
  assert.equal(h.sent[0]?.seat, 3)
  assert.equal(h.sent[0]?.buyIn, 5000)
})

test('牌桌命令：离线时命令不发送，但要给出可读提示', async () => {
  const h = makeCommandHarness({ seat: null, stack: 0, away: false })
  h.setOnline(false)
  h.value.pickSeat(1)
  h.value.confirmBuyIn(3000)
  await nextTick()
  assert.equal(h.sent.length, 0, '离线不该发命令')
  assert.ok(
    h.announced.some((text) => text.includes('未连接') || text.includes('未发送')),
    `应播报未连接提示，实际：${h.announced.join(' / ')}`,
  )
})

test('牌桌命令：本手里点离座先弹确认；确认后才发 seat.leave', async () => {
  const h = makeCommandHarness({ seat: 2, stack: 3000, away: false })

  // 手牌进行中（inHand 且未弃牌、未离座）：先弹确认，不发命令。
  h.value.requestLeaveSeat()
  await nextTick()
  assert.equal(h.value.inLiveHand.value, true)
  assert.equal(h.value.leaveSeatOpen.value, true)
  assert.equal(h.sent.length, 0, '弹确认时还不该发命令')

  h.value.leaveSeat()
  await nextTick()
  assert.equal(h.value.leaveSeatOpen.value, false)
  assert.equal(h.sent[0]?.type, 'seat.leave')
})

test('牌桌命令：提交动作带上 handId 与当前版本号（过期会被服务端拒绝）', async () => {
  const h = makeCommandHarness({ seat: 2, stack: 3000, away: false })
  h.value.submitAction({ action: 'call' })
  await nextTick()
  assert.equal(h.sent[0]?.type, 'game.action')
  assert.equal(h.sent[0]?.handId, 'h-1')
  assert.equal(h.sent[0]?.expectedVersion, 3)
  assert.equal(h.sent[0]?.action, 'call')
})
