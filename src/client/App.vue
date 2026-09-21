<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <!-- 路由外壳：所有页面按整屏高度排布，牌桌需要占满剩余空间。 -->
  <div class="app-shell">
    <a class="skip-link" href="#main">跳到主要内容</a>
    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* 键盘用户第一个 Tab 即可跳过装饰内容。 */
.skip-link {
  position: absolute;
  left: var(--space-2);
  top: -60px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 14px;
  background: var(--gold);
  color: var(--bg);
  font-weight: 600;
  border-radius: var(--radius-sm);
  transition: top 0.16s ease-out;
}

.skip-link:focus-visible {
  top: var(--space-2);
}
</style>
