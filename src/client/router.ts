import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

/**
 * 路由表（规格书 §3.2）。
 *   /                 大厅：品牌主视觉 + 创建 / 加入房间
 *   /table/:roomId    核心实时牌桌（也是邀请链接的落地页：先旁观，自己选座买入）
 *
 * 第 5 项需求删掉了「等候页」：填完昵称直接进牌桌，此时还没落座，
 * 桌子上会显示空位，点空位确认买入后才入座。
 *   /error            链接过期 / 房间已满 / 被移出 / 版本不兼容
 *   /:pathMatch(.*)   兜底 → 链接无效
 *
 * 生产环境由同一个 Fastify 进程做 SPA fallback，因此使用 history 模式。
 */
export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'lobby',
    component: () => import('./views/LobbyView.vue'),
    meta: { title: '开一桌 · Poker Room' },
  },
  {
    path: '/table/:roomId',
    name: 'table',
    component: () => import('./views/TableView.vue'),
    props: true,
    meta: { title: '牌桌 · Poker Room' },
  },
  {
    path: '/error',
    name: 'error',
    component: () => import('./views/ErrorView.vue'),
    meta: { title: '无法进入房间 · Poker Room' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./views/ErrorView.vue'),
    meta: { title: '链接无效 · Poker Room' },
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = typeof title === 'string' ? title : 'Poker Room'
})

export default router
