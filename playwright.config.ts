import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3300)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

/**
 * 端到端配置（规格书第 5 阶段）。
 *
 * - 使用系统已安装的 Google Chrome（channel: 'chrome'），不额外下载浏览器内核；
 *   受限环境里 Chrome 自身沙箱可能无法初始化，因此带 --no-sandbox。
 * - webServer 用一个**独立端口 + 独立数据库**启动生产进程，
 *   顺带验证「单次部署后一个端口同时提供网页、HTTP API 与 WebSocket」。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'artifacts/playwright',
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--no-sandbox', '--disable-gpu'] },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    // MAX_ROOMS 放宽：整个 e2e 轮次共用这一个服务端，多个用例各自建房会撞上「最多 3 桌」的
    // 产品上限（该上限本身由 tests/features.test.ts 单独覆盖）。
    /*
     * 起服务前先清库：e2e 建的房间不会在用例结束时关闭，残留会在下一轮被「从快照恢复」，
     * 于是撞上 MAX_ROOMS 或带进上一轮的牌局状态（曾导致 14 条里随机挂 1 条）。
     * 放在 webServer.command 里，直接跑 `npx playwright test` 也能清干净。
     */
    command: `node scripts/reset-e2e-db.mjs && HOST=127.0.0.1 PORT=${PORT} DATABASE_PATH=./data/e2e.sqlite NODE_ENV=production MAX_ROOMS=20 node dist/server/index.js`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
