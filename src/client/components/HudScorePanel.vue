<script setup lang="ts">
import { computed } from 'vue'
import type { PlayerScorePublic } from '../../shared/protocol.ts'

/**
 * 牌桌 HUD「计分板」：本桌累计虚拟筹码。
 *
 * 展示型组件——排序、合计在内部算好，展开状态与外部点击收起由父组件（useHudPanels）管。
 * 曾入座后离桌的玩家仍保留记录，所以这里不按 `seated` 过滤。
 */
const props = defineProps<{
  /** 服务端下发的累计计分（含已离桌）。 */
  scores: readonly PlayerScorePublic[]
  /** 当前是否展开。 */
  open: boolean
}>()

const emit = defineEmits<{ (event: 'toggle'): void; (event: 'close'): void }>()

/** 净筹码降序；同额时买入多的排前面，避免每次刷新顺序乱跳。 */
const rows = computed(() =>
  [...props.scores].sort((a, b) => b.net - a.net || b.totalBuyIn - a.totalBuyIn),
)

const totalBuyIn = computed(() => rows.value.reduce((sum, row) => sum + row.totalBuyIn, 0))
</script>

<template>
  <aside class="hud-anchor hud-score-anchor" aria-label="牌桌计分板">
    <button
      type="button"
      class="hud-capsule-btn hud-score-pill"
      :class="{ 'is-active': open }"
      :title="open ? '收起计分板' : '展开计分板'"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      <i class="pi pi-chart-bar hud-capsule-icon" aria-hidden="true" />
      <span class="hud-capsule-label">计分板</span>
      <i :class="open ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" class="hud-capsule-arrow" aria-hidden="true" />
    </button>
    <Transition name="hud-score-popover">
      <div v-show="open" class="hud-popover hud-score-popover">
        <header class="hud-popover-header">
          <div class="hud-popover-title"><i class="pi pi-chart-bar" aria-hidden="true" /><span>本桌计分板</span></div>
          <button type="button" class="hud-popover-close-btn" title="收起计分板" aria-label="收起计分板" @click="emit('close')">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>
        <div class="hud-score-summary">{{ rows.length }} 位玩家 · 累计买入 <b class="num">{{ totalBuyIn }}</b></div>
        <div class="hud-score-scroll thin-scroll">
          <p v-if="rows.length === 0" class="hud-score-empty">暂无入座记录</p>
          <table v-else class="hud-score-table">
            <thead>
              <tr>
                <th scope="col">玩家</th>
                <th scope="col">净筹码</th>
                <th scope="col">总买入</th>
                <th scope="col">现有</th>
                <th scope="col">带离</th>
                <th scope="col">手数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.playerId">
                <th scope="row">
                  <span>{{ row.nickname }}</span>
                  <small>{{ row.seated ? '在桌' : '已离桌' }} · 买入 {{ row.buyInCount }} 次</small>
                </th>
                <td class="num" :class="row.net > 0 ? 'score-up' : row.net < 0 ? 'score-down' : ''">
                  {{ row.net > 0 ? '+' : '' }}{{ row.net }}
                </td>
                <td class="num">{{ row.totalBuyIn }}</td>
                <td class="num">{{ row.stack }}</td>
                <td class="num">{{ row.banked }}</td>
                <td class="num">{{ row.handsPlayed }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hud-score-note">虚拟筹码 · 净筹码 = 现有 + 带离 − 总买入；进行中随下注变化</p>
      </div>
    </Transition>
  </aside>
</template>
