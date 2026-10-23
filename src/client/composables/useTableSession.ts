import { onBeforeUnmount, onMounted, ref } from 'vue'
import { SessionError, connectRoom, fetchRoomInfo, joinRoom as apiJoinRoom } from '../net/session.ts'
import { ROOM_PASSWORD_DIGITS } from '../../shared/poker.ts'
import type { RoomCredentials, RoomInfoResponse } from '../../shared/protocol.ts'

/**
 * 牌桌的「接入」逻辑：凭证恢复、WebSocket 连接、邀请链接落地页表单。
 *
 * 从 `TableView.vue` 抽出。这里的判定顺序很关键，写错会让「刷新后回不到牌桌」：
 *   1. 本地有本房间凭证 → 直接连（刷新/重连都走这条）；
 *   2. 开发模式 `/table/dev` → 用模拟场景；
 *   3. 都没有 → 拉到房间公开信息，显示「填昵称+密码进桌」。
 *
 * 注意：**连接建立后不再由这里维护**——`session.ts` 内部负责重连与心跳，
 * 这里只发起第一次连接并暴露表单状态。
 */
export interface TableSessionOptions {
  /** 路由里的房间号。 */
  roomId: () => string
  /** 开发模式：当前 mock 场景名（真实环境为 undefined）。 */
  scenario: () => string
  /** 从本地存储读凭证。 */
  loadCredentials: (roomId: string) => RoomCredentials | null
  /** 当前 store 里已有的凭证（可能来自上一次进入）。 */
  storedCredentials: () => RoomCredentials | null
  /** 写入 store。 */
  setCredentials: (credentials: RoomCredentials) => void
  /** 恢复昵称（进桌表单的默认值）。 */
  defaultNickname: () => string
  /** 应用一次模拟快照（仅开发模式）。 */
  applyScenario: (name: string) => Promise<{ kind: 'redirect' } | { kind: 'ok' }>
  /** 模拟场景需要跳错误页时调用。 */
  onScenarioRedirect: () => void
  /** 是否开发模式。 */
  isDev: boolean
}



export function useTableSession(options: TableSessionOptions) {
  /* ───────────── 邀请链接落地页表单 ───────────── */

  const joining = ref(false)
  const joinNickname = ref(options.defaultNickname())
  const joinPassword = ref('')
  const joinError = ref('')
  const joinInfo = ref<RoomInfoResponse | null>(null)
  const joinInfoError = ref('')

  /** 先取公开信息（房间名/人数），失败就给出可执行的提示，而不是白屏。 */
  async function loadJoinInfo(): Promise<void> {
    try {
      joinInfo.value = await fetchRoomInfo(options.roomId())
    } catch (cause) {
      joinInfoError.value =
        cause instanceof SessionError && cause.code === 'room_not_found'
          ? '这个房间不存在或已经解散，请向房主要一条新的邀请链接。'
          : '暂时连不上服务器，请稍后重试。'
    }
  }

  /** 提交进桌表单：本地校验 → 服务端校验 → 建连。 */
  async function submitJoin(): Promise<void> {
    joinError.value = ''
    const nickname = joinNickname.value.trim()
    if (!nickname) {
      joinError.value = '请先填写昵称。'
      return
    }
    if (!new RegExp(`^\\d{${String(ROOM_PASSWORD_DIGITS)}}$`).test(joinPassword.value)) {
      joinError.value = `请输入 ${String(ROOM_PASSWORD_DIGITS)} 位数字房间密码。`
      return
    }
    joining.value = true
    try {
      const credentials = await apiJoinRoom(options.roomId(), {
        nickname,
        password: joinPassword.value,
      })
      options.setCredentials(credentials)
      connectRoom(credentials)
    } catch (cause) {
      joinError.value = cause instanceof SessionError ? cause.message : '加入失败，请稍后重试。'
    } finally {
      joining.value = false
    }
  }

  /* ───────────── 首次接入 ───────────── */

  /**
   * 接入优先级：本地有房间凭证 → 真实 WebSocket；
   * 开发模式的 /table/dev → 模拟场景；
   * 真实房间没有凭证时显示「填昵称加入」面板。
   */
  function bootstrap(): void {
    const roomId = options.roomId()
    const stored = options.storedCredentials()
    const credentials = stored?.roomId === roomId ? stored : options.loadCredentials(roomId)
    if (credentials) {
      options.setCredentials(credentials)
      connectRoom(credentials)
      return
    }
    if (options.isDev && roomId === 'dev') {
      void options.applyScenario(options.scenario()).then((result) => {
        if (result.kind === 'redirect') options.onScenarioRedirect()
      })
      return
    }
    void loadJoinInfo()
  }

  const mountedCleanups: (() => void)[] = []

  /** 注册一个随组件卸载自动清理的副作用。 */
  function onMountedCleanup(cleanup: () => void): void {
    mountedCleanups.push(cleanup)
  }

  onMounted(() => {
    bootstrap()
  })

  onBeforeUnmount(() => {
    for (const cleanup of mountedCleanups) cleanup()
    mountedCleanups.length = 0
  })

  return {
    joining,
    joinNickname,
    joinPassword,
    joinError,
    joinInfo,
    joinInfoError,
    loadJoinInfo,
    submitJoin,
    bootstrap,
    onMountedCleanup,
  }
}
