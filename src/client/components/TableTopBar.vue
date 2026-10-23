<script setup lang="ts">
import { watch } from 'vue'
import Button from 'primevue/button'
import { useSoundControl } from '../composables/useSoundControl.ts'

/**
 * 牌桌顶栏：房间信息（房间名 / 房主 / 盲注 / 手数 / 阶段 / 连接状态）
 * + 右侧工具（配置 / 声音 / 分享）。
 *
 * 二次操作（聊天、计分板、手牌历史）已迁到桌面上的 HUD 胶囊，不再塞进顶栏，
 * 这样 1440→600px 全程单行。
 */
const props = defineProps<{
  roomName: string
  isHost: boolean
  smallBlind: number
  bigBlind: number
  handNo: number
  /** 阶段名（翻牌前 / 翻牌 / 转牌 / 河牌 / 结算）。 */
  streetText: string
  /** 阶段 key，用于胶囊配色。 */
  street: string
  online: boolean
}>()

/**
 * 房间名不再占 H5 顶栏宽度：390px 竖屏下「房间名 + 你是房主 + 盲注 + 连接状态 + 4 个工具图标」
 * 放不进一行，是用户反馈的互相压住。视觉上交给 table-top-bar.css 在竖屏隐藏，
 * 名字保留两处：
 *   1. 浏览器标签页标题（document.title）：「XX 的牌局 · 牌桌」；
 *   2. 顶栏 h1 用 sr-only 呈现，读屏仍能读到。
 * 路由 afterEach 只在导航时写 title；这里 watch 房间名，进入真实房间后覆盖为具体房间名。
 */
watch(
  () => props.roomName,
  (roomName) => {
    // TableView 在牌局快照到达前传的是占位文案「牌桌」，此时不改标题，避免出现「牌桌 · 牌桌」。
    if (!roomName || roomName === '牌桌') return
    document.title = `${roomName} · 牌桌`
  },
  { immediate: true },
)

const emit = defineEmits<{
  (event: 'configure'): void
  (event: 'share'): void
  (event: 'members'): void
}>()

// 声音控制状态与行为在 composable 里；顶栏自己持有实例即可（只有这里用）。
const {
  panelOpen: soundPanelOpen,
  icon: soundIcon,
  summary: soundSummary,
  soundEnabled: soundOn,
  bgmEnabled: bgmOn,
  toggleSound,
  toggleBgm,
  togglePanel,
} = useSoundControl()
</script>

<template>
  <header class="bar hud-header">
      <div class="hud-left">
        <div class="room-badge">
          <i class="pi pi-shield room-badge-icon" aria-hidden="true" />
          <h1 class="bar-title">{{ roomName }}</h1>
          <span v-if="isHost" class="host-label">你是房主</span>
        </div>
        <div class="meta-capsules">
          <span class="stat meta-pill meta-pill--blind">
            <span class="meta-label">盲注</span>
            <b class="num">{{ smallBlind }}/{{ bigBlind }}</b>
          </span>
          <span class="stat stat--hand meta-pill meta-pill--hand">
            <span class="meta-label">第</span>
            <b class="num">{{ handNo }}</b>
            <span>手</span>
          </span>
          <span class="stat stat--stage meta-pill meta-pill--stage" :class="`stage--${street}`">
            <span class="meta-label">阶段</span>
            <b class="stage-name">{{ streetText }}</b>
          </span>
        </div>
        <span
          class="link-state"
          :class="online ? 'is-online' : 'is-offline'"
          role="status"
        >
          <i :class="online ? 'pi pi-wifi' : 'pi pi-exclamation-triangle'" aria-hidden="true" />
          <span>{{ online ? '已连接' : '连接异常' }}</span>
        </span>
      </div>

      <span class="bar-spacer" />


      <!-- 顶栏右侧操作区：配置、声音、分享 -->
      <div class="bar-right" role="toolbar" aria-label="牌桌快捷工具栏">
        <Button v-if="isHost" size="small" text class="bar-btn" aria-label="牌局配置" title="修改牌局配置" @click="emit('configure')">
          <i class="pi pi-cog" aria-hidden="true" />
          <span class="bar-btn-text">配置</span>
        </Button>

        <!-- 房主专属：管理房间成员（移除捣乱的人） -->
        <Button
          v-if="isHost"
          size="small"
          text
          class="bar-btn bar-btn--members"
          aria-label="管理成员"
          title="管理成员：把某人移出房间"
          @click="emit('members')"
        >
          <i class="pi pi-users" aria-hidden="true" />
          <span class="bar-btn-text">成员</span>
        </Button>

        <!--
          声音控制：音效与背景音乐两个独立开关。
          必须点击才解锁音频（浏览器自动播放策略），因此默认都是关闭的。
        -->
        <div class="sound-control">
          <Button
            size="small"
            text
            class="bar-btn bar-btn--sound"
            :aria-label="`声音设置：${soundSummary}`"
            :title="`声音：${soundSummary}`"
            :aria-expanded="soundPanelOpen"
            @click="togglePanel()"
          >
            <i :class="soundIcon" aria-hidden="true" />
            <span class="bar-btn-text">声音</span>
          </Button>

          <Transition name="sound-popover">
            <div v-if="soundPanelOpen" class="sound-popover" role="dialog" aria-label="声音设置">
              <label class="sound-row">
                <span class="sound-row-text">
                  <i class="pi pi-volume-up" aria-hidden="true" />
                  <span>对局音效</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  class="sound-switch"
                  :class="{ 'is-on': soundOn }"
                  :aria-checked="soundOn"
                  aria-label="对局音效开关"
                  @click="toggleSound()"
                >
                  <span class="sound-switch-knob" />
                </button>
              </label>
              <label class="sound-row">
                <span class="sound-row-text">
                  <i class="pi pi-play-circle" aria-hidden="true" />
                  <span>背景音乐</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  class="sound-switch"
                  :class="{ 'is-on': soundOn && bgmOn }"
                  :aria-checked="soundOn && bgmOn"
                  aria-label="背景音乐开关"
                  @click="toggleBgm()"
                >
                  <span class="sound-switch-knob" />
                </button>
              </label>
              <p class="sound-hint">背景音乐音量已压在音效之下，适合长时间开着。</p>
            </div>
          </Transition>
        </div>

        <!-- 分享按钮：快捷桌牌与复制入口 -->
        <Button
          size="small"
          text
          class="bar-btn bar-btn--invite"
          aria-label="分享房间"
          :title="'分享房间：房间号与邀请链接'"
          @click="emit('share')"
        >
          <i class="pi pi-share-alt" aria-hidden="true" />
          <span class="bar-btn-text">分享</span>
        </Button>
      </div>
  </header>
</template>
