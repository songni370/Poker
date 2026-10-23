<script setup lang="ts">
import { computed } from 'vue'

/**
 * 操作区顶部的「行动倒计时舱」：进度条 + 剩余秒数融在同一条胶囊跑道里。
 *
 * 从 ActionBar.vue 抽出（那里有 1794 行，倒计时舱自成一块且只依赖 4 个数值）。
 * 剩余秒数为 0 或未轮到自己时由父组件决定是否渲染，这里只负责画。
 */
const props = withDefaults(
  defineProps<{
    /** 剩余秒数。 */
    remainingSeconds?: number
    /** 本手行动总时长（秒），用于进度条比例与 aria-valuemax。 */
    turnSeconds?: number
    /** 剩余比例 0–1。 */
    remainingRatio?: number | null
  }>(),
  { remainingSeconds: 0, turnSeconds: 20, remainingRatio: 1 },
)

/** 最后 5 秒进入「紧迫」态：红色描边 + 呼吸动画。 */
const isUrgent = computed(() => props.remainingSeconds <= 5)
</script>

<template>
  <div
    class="turn-timer-integrated"
    :class="{ 'is-urgent': isUrgent }"
    role="progressbar"
    :aria-valuenow="remainingSeconds"
    aria-valuemin="0"
    :aria-valuemax="turnSeconds"
    :aria-label="`行动倒计时，剩余 ${String(remainingSeconds)} 秒`"
  >
    <!-- 进度条底槽与平滑硬件加速填充层 -->
    <div class="timer-track-bar">
      <div class="timer-progress-fill" :style="{ transform: `scaleX(${String(remainingRatio ?? 1)})` }" />
      <div class="timer-ambient-glow" />
    </div>

    <!-- 居中内嵌倒计时信息：行动提示与醒目时间数字 -->
    <div class="timer-overlay-content">
      <div class="timer-lead">
        <i class="pi pi-clock timer-lead-icon" aria-hidden="true" />
        <span class="timer-lead-title">轮到你行动</span>
      </div>
      <div class="timer-time-box num">
        <span class="timer-digits">{{ remainingSeconds }}</span>
        <span class="timer-unit">S</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ───────────── 1. 一体化竞技倒计时舱 (进度条与时间深度融铸) ───────────── */
.turn-timer-integrated {
  position: relative;
  width: 100%;
  height: 26px;
  border-radius: 999px;
  overflow: hidden;
  /* 拟物：内凹金属凹槽 + 黄铜细框，填充层带顶部高光 */
  background: #0c0906;
  border: 1px solid rgba(165, 128, 60, 0.75);
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.9),
    0 1px 0 rgba(255, 255, 255, 0.08),
    0 3px 8px rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  user-select: none;
  box-sizing: border-box;
}

.turn-timer-integrated.is-urgent {
  border-color: rgba(239, 68, 68, 0.85);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 14px rgba(239, 68, 68, 0.65);
  animation: timer-pulse-urgent 0.8s infinite alternate ease-in-out;
}

@keyframes timer-pulse-urgent {
  0% {
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 6px rgba(239, 68, 68, 0.3);
  }
  100% {
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 16px rgba(239, 68, 68, 0.85);
  }
}

.timer-track-bar {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.timer-progress-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: linear-gradient(180deg, #9af0a9 0%, #4fbf67 55%, #2d8243 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
  border-radius: inherit;
  will-change: transform;
}

.turn-timer-integrated.is-urgent .timer-progress-fill {
  background: linear-gradient(180deg, #ff8a8a 0%, #d63a3a 55%, #9e1f1f 100%);
}

.timer-ambient-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.08) 0%, transparent 80%);
  pointer-events: none;
}

.timer-overlay-content {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  pointer-events: none;
  box-sizing: border-box;
}

.timer-lead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #f6ecd8;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
}

.timer-lead-icon {
  font-size: 0.8rem;
  color: #ffdf9a;
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.8));
}

.is-urgent .timer-lead-icon {
  color: #fca5a5;
  animation: timer-spin 1.5s linear infinite;
}

@keyframes timer-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.timer-time-box {
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-weight: 900;
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.9);
  font-variant-numeric: tabular-nums;
}

.timer-digits {
  font-size: 0.98rem;
  letter-spacing: 0.02em;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000;
}

.is-urgent .timer-digits {
  color: #fee2e2;
  text-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
}

.timer-unit {
  font-size: 0.68rem;
  font-weight: 700;
  opacity: 0.9;
  color: #f8fafc;
}
</style>
