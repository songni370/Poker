import { computed, ref, watch } from 'vue'
import { TABLE_RULES } from '../../shared/poker.ts'
import type { ActionType } from '../../shared/poker.ts'

/**
 * 牌桌的全部「发命令」逻辑：入座 / 换座 / 离座 / 退出 / 提交动作 / 开局 / 移除玩家。
 *
 * 从 `TableView.vue` 抽出，原因：
 *   - 这些动作都要走同一个 `sendCommand`，而它带 requestId 幂等、离线兜底与
 *     「无障碍播报」三件事，散在页面里容易漏掉其中一件；
 *   - 页面组件只该关心「渲染 + 把用户点击转成命令」，命令的时机与文案属于业务。
 *
 * 这里**不碰渲染**：所有状态都是 ref/computed，由页面取用。
 */

export interface TableCommandsOptions {
  /** 发送一条协议命令；返回 false 表示当前未连接。 */
  sendCommand: (command: unknown) => boolean
  /** 生成幂等 requestId。 */
  nextRequestId: () => string
  /** 无障碍播报（aria-live 区域）。 */
  announce: (text: string) => void
  /** 牌局状态快照（只读）。 */
  state: () => TableStateLike | null | undefined
  /** 本人座位（只读）。 */
  mySeat: () => SeatLike | null | undefined
  /** 本人 playerId（只读）。 */
  selfSeat: () => number | null | undefined
  /** 是否主持人。 */
  isHost: () => boolean
  /** 是否已连接。 */
  isOnline: () => boolean
  /** 房间成员（用于移除玩家）。 */
  members: () => readonly { playerId: string; nickname: string }[]
  /** 退出房间后清本地凭证。 */
  onExitRoom: () => void
}

/** 只读的座位切片（避免和协议层强耦合）。 */
export interface SeatLike {
  away?: boolean
  inHand?: boolean
  folded?: boolean
  stack?: number
  committedStreet?: number
}

/** 只读的牌局状态切片。 */
export interface TableStateLike {
  handId?: string | null
  version?: number
  phase?: string
  handNo?: number
  buyInMin?: number
  buyInMax?: number
  buyInStep?: number
  turnSeconds?: number
  maxSeats?: number
}

export function useTableCommands(options: TableCommandsOptions) {
  const state = () => options.state() ?? null
  const mySeat = () => options.mySeat() ?? null

  /* ───────────── 买入 / 重新买入 ───────────── */

  const buyInOpen = ref(false)
  const buyInSeat = ref<number | null>(null)
  const isRebuyDialog = ref(false)

  const buyInMin = computed(() => state()?.buyInMin ?? 0)
  const buyInMax = computed(() => state()?.buyInMax ?? 0)
  const buyInStep = computed(() => state()?.buyInStep ?? TABLE_RULES.smallBlind)
  const canRebuy = computed(() => Boolean(mySeat()) && options.isOnline())

  /** 打开买入弹窗：默认给满上限（最少点击），下限/上限/步进都来自服务端。 */
  function openBuyIn(seat: number): void {
    isRebuyDialog.value = false
    buyInSeat.value = seat
    buyInOpen.value = true
  }

  function openRebuy(): void {
    const seat = options.selfSeat()
    if (seat !== null && seat !== undefined && canRebuy.value) {
      openBuyIn(seat)
      isRebuyDialog.value = true
    }
  }

  /** BuyInDialog 已按步进取整，这里只负责发命令。 */
  function confirmBuyIn(amount: number): void {
    const seat = buyInSeat.value
    if (seat === null) return
    const rebuy = isRebuyDialog.value
    if (
      !options.sendCommand(
        rebuy
          ? { type: 'seat.rebuy', requestId: options.nextRequestId(), buyIn: amount }
          : { type: 'seat.take', requestId: options.nextRequestId(), seat, buyIn: amount },
      )
    ) {
      options.announce('尚未连接到服务器，入座请求未发送。')
      return
    }
    options.announce(
      rebuy
        ? `正在重新买入 ${String(amount)} 筹码。`
        : `正在坐到 ${String(seat + 1)} 号座位，买入 ${String(amount)} 筹码。`,
    )
    buyInOpen.value = false
    buyInSeat.value = null
  }

  function cancelBuyIn(): void {
    buyInSeat.value = null
  }

  /* ───────────── 座位挑选 / 坐回 ───────────── */

  /** 本人离座但座位仍被保留。 */
  const mySeatAway = computed(() => Boolean(mySeat()?.away))
  /** 本人保留的座位号（没离座则为 null）。 */
  const myReservedSeat = computed(() => (mySeatAway.value ? (options.selfSeat() ?? null) : null))
  /** 保留座位里的筹码：>0 可直接坐回，=0 说明输光需要重新买入。 */
  const myReservedStack = computed(() => mySeat()?.stack ?? 0)
  /**
   * 是否坐在座位上（不是旁观）。
   *
   * 判据是「有没有 mySeat」而不是「有没有 self.seat」——观战者也有 self，
   * 但 mySeat 为空。早先用 selfSeat 判断，导致观战者被当成在座、桌面不画空位。
   */
  function isSeated(): boolean {
    return mySeat() !== null
  }

  /** 能不能在桌面上挑座位：未入座（旁观）或已离座但保留座位。 */
  const canPickSeat = computed(() => !isSeated() || mySeatAway.value)

  /** 本人本轮已投入底池的筹码。 */
  const myCommittedStreet = computed(() => mySeat()?.committedStreet ?? 0)

  /**
   * 离座玩家换到任意空位：直接发 seat.take。
   * 服务端会把自己的筹码原样转到新座位（筹码属于玩家，不属于座位）。
   */
  function takeSeatWithoutBuyIn(seat: number): void {
    if (
      !options.sendCommand({
        type: 'seat.take',
        requestId: options.nextRequestId(),
        seat,
        buyIn: myReservedStack.value,
      })
    ) {
      options.announce('尚未连接到服务器，换座请求未发送。')
      return
    }
    options.announce(`正在坐到 ${String(seat + 1)} 号座位，筹码原样带回。`)
  }

  /**
   * 点桌面空位：
   *   - 已离座且筹码 > 0 → 不弹窗直接坐下（筹码跟人走）；
   *   - 否则弹买入确认（房主设定的买入区间）。
   */
  function pickSeat(seat: number): void {
    if (mySeatAway.value && myReservedStack.value > 0) {
      takeSeatWithoutBuyIn(seat)
      return
    }
    openBuyIn(seat)
  }

  /** 坐回保留座位：筹码 > 0 直接坐回，输光了走买入弹窗。 */
  function resit(): void {
    const seat = options.selfSeat()
    if (seat === null || seat === undefined) return
    if (myReservedStack.value > 0) {
      takeSeatWithoutBuyIn(seat)
      return
    }
    openBuyIn(seat)
  }

  /* ───────────── 离座 / 退出 ───────────── */

  /** 本手里还在牌局中（未弃牌）：离座会同时弃牌，先让玩家确认。 */
  const inLiveHand = computed(() => Boolean(mySeat()?.inHand && !mySeat()?.folded && !mySeatAway.value))
  const leaveSeatOpen = ref(false)
  const exitRoomOpen = ref(false)

  function requestLeaveSeat(): void {
    if (inLiveHand.value) {
      leaveSeatOpen.value = true
      return
    }
    leaveSeat()
  }

  function leaveSeat(): void {
    leaveSeatOpen.value = false
    if (!options.sendCommand({ type: 'seat.leave', requestId: options.nextRequestId() })) {
      options.announce('尚未连接到服务器，离座请求未发送。')
      return
    }
    options.announce('已离座，座位与筹码为你保留，随时可以坐回。')
  }

  function exitRoom(): void {
    exitRoomOpen.value = false
    if (!options.sendCommand({ type: 'room.leave', requestId: options.nextRequestId() })) {
      options.announce('尚未连接到服务器，退出请求未发送。')
      return
    }
    options.onExitRoom()
  }

  /* ───────────── 提交动作 / 开局 ───────────── */

  function submitAction(payload: { action: ActionType; amount?: number }): void {
    const current = state()
    if (!current || !current.handId) {
      options.announce('牌局尚未开始，无法行动。')
      return
    }
    const sent = options.sendCommand({
      type: 'game.action',
      requestId: options.nextRequestId(),
      handId: current.handId,
      expectedVersion: current.version,
      action: payload.action,
      ...(payload.amount === undefined ? {} : { amount: payload.amount }),
    })
    options.announce(sent ? '已提交动作，等待服务端裁定。' : '尚未连接到服务器，动作未发送。')
  }

  /** 是否已经开过手：决定按钮文案是「开始牌局」还是「开始下一手」。 */
  const hasPlayedHand = computed(() => (state()?.handNo ?? 0) > 0)

  /** 主持人开始下一手（结算后无需回到等待区）。 */
  const canStartNextHand = computed(() => {
    const current = state()
    return options.isHost() && Boolean(current) && (current?.phase === 'waiting' || current?.phase === 'settlement')
  })

  function startNextHand(): void {
    if (!options.sendCommand({ type: 'game.start', requestId: options.nextRequestId() })) {
      options.announce('尚未连接到服务器，无法开始下一手。')
    }
  }

  /* ───────────── 主持人移除玩家 ───────────── */

  const kickOpen = ref(false)

  function requestMembers(): void {
    options.sendCommand({ type: 'room.members', requestId: options.nextRequestId() })
  }

  // 打开弹窗时拉一次名单；开着的时候跟着房间版本号走（版本号在广播里都会推进）。
  watch(
    () => (kickOpen.value ? (state()?.version ?? 0) : 0),
    () => {
      if (kickOpen.value) requestMembers()
    },
  )

  function confirmKick(playerId: string): void {
    const target = options.members().find((member) => member.playerId === playerId) ?? null
    if (!target) return
    if (!options.sendCommand({ type: 'room.kick', requestId: options.nextRequestId(), playerId: target.playerId })) {
      options.announce('尚未连接到服务器，移除请求未发送。')
      return
    }
    options.announce(`已请求移除 ${target.nickname}。`)
    // 名单只认服务端：room.player_left 广播后重新拉一次，不做乐观更新。
    requestMembers()
  }

  return {
    // 买入
    buyInOpen,
    buyInSeat,
    isRebuyDialog,
    buyInMin,
    buyInMax,
    buyInStep,
    canRebuy,
    openBuyIn,
    openRebuy,
    confirmBuyIn,
    cancelBuyIn,
    // 座位
    mySeatAway,
    myReservedSeat,
    myReservedStack,
    canPickSeat,
    myCommittedStreet,
    pickSeat,
    resit,
    takeSeatWithoutBuyIn,
    // 离座 / 退出
    inLiveHand,
    leaveSeatOpen,
    exitRoomOpen,
    requestLeaveSeat,
    leaveSeat,
    exitRoom,
    // 动作 / 开局
    submitAction,
    hasPlayedHand,
    canStartNextHand,
    startNextHand,
    // 成员
    kickOpen,
    requestMembers,
    confirmKick,
  }
}
