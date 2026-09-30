<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import { useConnectionStore } from '../stores/connection.ts'

/**
 * 链路状态提示条。
 * idle / online 不占位；connecting / reconnecting / offline 才出现，
 * 并用 role=status + aria-live 让屏幕阅读器也能感知。
 */
const connection = useConnectionStore()

const visible = computed(() => connection.isDegraded)

const severity = computed<'warn' | 'error' | 'info'>(() => {
  if (connection.status === 'offline') return 'error'
  if (connection.status === 'reconnecting') return 'warn'
  return 'info'
})

const icon = computed(() => {
  switch (connection.status) {
    case 'connecting':
      return 'pi pi-spin pi-spinner'
    case 'reconnecting':
      return 'pi pi-refresh'
    default:
      return 'pi pi-exclamation-triangle'
  }
})

const text = computed(() => {
  switch (connection.status) {
    case 'connecting':
      return '正在连接牌桌…'
    case 'reconnecting':
      return `连接已断开，正在重连（第 ${String(connection.reconnectCount)} 次）`
    case 'offline':
      return '当前离线：操作已暂停，恢复后会自动同步最新牌局状态。'
    default:
      return ''
  }
})

/** 第 3 阶段接入：这里触发立即重连，不需要刷新页面。 */
function retry(): void {
  connection.setStatus('connecting')
}
</script>

<template>
  <div v-if="visible" class="banner" :class="`banner--${severity}`" role="status" aria-live="assertive">
    <i :class="icon" aria-hidden="true" />
    <span class="text">{{ text }}</span>
    <Button v-if="connection.status === 'offline'" size="small" text :title="'立即重试连接'" @click="retry">
      <i class="pi pi-refresh" aria-hidden="true" />
      <span>立即重试</span>
    </Button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 6px var(--space-2);
  font-size: 0.82rem;
  border-bottom: 1px solid var(--line);
}

.banner--info {
  background: color-mix(in srgb, var(--action) 22%, var(--bg-elevated));
  color: var(--text);
}

.banner--warn {
  background: color-mix(in srgb, var(--gold) 20%, var(--bg-elevated));
  color: var(--text);
}

.banner--error {
  background: color-mix(in srgb, var(--danger) 24%, var(--bg-elevated));
  color: var(--text);
}

.text {
  flex: 1;
  min-width: 0;
}

/*
 * 极矮横屏（740×360 这类）：横幅改成覆盖式状态条，
 * 不占布局高度，避免把牌桌与操作区挤出视口（原来会多出 33px 纵向滚动）。
 */
</style>
