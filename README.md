# Poker Room

朋友之间的网页版德州扑克，仅使用虚拟、不可兑换筹码，无充值、提现或支付功能。

## 运行

需要 Node.js ≥ 24。

```bash
npm ci
npm run build
npm start
```

默认访问 `http://localhost:3000`。Fastify 在同一端口提供网页、HTTP API 与 WebSocket，生产环境只启动一个进程。
首次启动自动创建 `data/poker.sqlite` 并执行迁移。升级和清理时保留 `data/`，其中包含牌局数据和备份。

开发使用 `npm run dev`：前端 `http://localhost:5173`，服务端 `http://localhost:3000`。

## 目录

| 目录 | 用途 |
|---|---|
| `src/client` | Vue 页面、组件与状态 |
| `src/server` | Fastify、WebSocket、房间管理与 SQLite |
| `src/engine` | 纯 TypeScript 扑克规则 |
| `src/shared` | 协议校验与共享类型 |
| `migrations` | 数据库迁移 |
| `scripts` | 开发、部署检查与备份工具 |
| `tests` | 单元、集成与浏览器测试 |

牌堆、手牌和筹码由服务端裁定，客户端只收到公开状态及本人的底牌。

## 检查与工具

```bash
npm run lint
npm run typecheck
npm test
npm run e2e           # 使用系统 Google Chrome，独立测试数据库
npm run check:deploy  # 检查已启动的服务
npm run backup        # 在独立数据库执行备份恢复演练
npm run probe:table   # 开发服务启动后检查牌桌几何
```

环境变量见 [`.env.example`](.env.example)，部署与备份说明见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。
`.npmrc` 将 npm 缓存设在项目内的 `.npm-cache/`，适配受限沙箱；缓存可重新生成。

界面使用 Vue 3、PrimeVue 4、Pinia，牌面和筹码使用自绘 CSS/SVG。PrimeVue 保持当前 MIT 许可版本，升级前确认许可变化。
