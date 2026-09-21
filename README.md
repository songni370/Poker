# Poker Room

朋友之间的**网页版德州扑克**：无需安装、开房即玩、断线可回桌。仅使用**虚拟、不可兑换筹码**，不含充值、提现、真钱下注或任何支付能力。

> 产品需求与验收标准见 [`docs/DeepSeek_Harness_德州扑克开发规格书.md`](docs/DeepSeek_Harness_德州扑克开发规格书.md)。本 README 只描述工程事实。

## 快速开始

```bash
npm ci
npm run build
npm start          # http://localhost:3000
```

首次启动会自动创建 `data/poker.sqlite` 并执行版本化迁移；重启数据保留。

开发模式（前端 HMR + 服务端 watch，两个进程，仅开发期）：

```bash
npm run dev        # 客户端 http://localhost:5173 · 服务端 http://localhost:3000
```

## 脚本合同

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发：Vite(5173) + Fastify(3000)，API/WS 由 Vite 代理 |
| `npm run build` | 构建前端 → `dist/client`，服务端 → `dist/server` |
| `npm start` | **唯一生产进程**：`node dist/server/index.js` |
| `npm run typecheck` | `vue-tsc`（客户端）+ `tsc`（服务端） |
| `npm run lint` | ESLint |
| `npm test` | Node 内置测试运行器（原生跑 TypeScript，无额外框架） |
| `npm run e2e` | 真实 Chrome 双会话端到端：建房 → 邀请加入 → 打完一手 → 开始下一手（需先 `npm run build && npm start`） |

`npm run e2e` 只通过 Chrome DevTools Protocol 驱动两个**相互隔离的浏览器上下文**（各自独立的 localStorage），
不引入 Playwright 等依赖；截图输出到 `artifacts/e2e/`。若受限环境里 Chrome 自身沙箱无法初始化，
脚本会加 `--no-sandbox`（仅访问本机页面、一次性临时用户目录）。

## 架构（不可妥协的约束）

一个仓库、一个 `package.json`、一个 Node 进程、一个端口、一次部署。**没有** Redis / MySQL / 独立前端部署 / 微服务 / 生产双进程。

```text
浏览器（Vue 3 + Vite 构建产物）
      │  同源 HTTP + WebSocket（同一端口）
      ▼
单个 Fastify 进程
  ├─ 静态文件：dist/client（SPA fallback，不覆盖 /api、/ws）
  ├─ HTTP API：/api/health、建房、加房 …
  ├─ WebSocket：/ws（订阅、心跳、动作、重连）
  ├─ RoomManager：Map<roomId, RoomRuntime>，每房串行处理
  ├─ PokerEngine：纯 TypeScript 规则逻辑（src/engine）
  └─ SQLite：data/poker.sqlite（WAL，自动迁移）
```

目录：`src/client`（Vue 页面/组件/状态）· `src/server`（Fastify、WS、房间管理、数据库）· `src/shared`（协议 schema 与共享类型）· `src/engine`（无框架依赖的规则引擎）· `migrations`（有序幂等 SQL）· `tests`。

## 环境变量

见 [`.env.example`](.env.example)：`HOST`、`PORT`、`DATABASE_PATH`、`CLIENT_DIR`、`NODE_ENV`、`LOG_LEVEL`。
生产建议 `HOST=0.0.0.0 PORT=3000`。启动日志会记录迁移版本、监听地址与数据库路径（不含密钥）。

## 数据与备份

- `data/` 为运行期持久数据，**已在 `.gitignore` 中**，构建与升级严禁删除。
- 升级流程固定为 `npm ci && npm run build && npm start`，不触碰 `data/`。
- 单实例约束：同一时刻只能有一个写入游戏状态的进程（PM2 只能 `instances: 1`、fork 模式）。

## 运行时技术选择

| 项 | 选择 | 说明 |
|---|---|---|
| Node | ≥ 24 | 需要 `node:sqlite` 与原生 TypeScript 执行 |
| SQLite 驱动 | **`node:sqlite`（标准库）** | 零依赖、无需数据库进程；`better-sqlite3` 等原生模块本次未引入 |
| 服务端构建 | `tsc`（NodeNext） | 源码用 `.ts` 扩展名导入，由 `rewriteRelativeImportExtensions` 在产出时改写为 `.js` |
| 测试 | `node --test` | 直接跑 `.ts`，不引入 vitest/jest |
| 客户端 | Vue 3 + Vite + **PrimeVue 4（MIT）** + Pinia | PrimeVue 仅用于表单/对话框等控件，牌桌视觉为自绘 |

> **PrimeVue 版本说明**：PrimeVue **5.x 及其配套 `primeicons@8` 已改为 PrimeTek 商业许可**，未配置许可证时会在生产界面右下角常驻 “Invalid PrimeVue License” 水印（本项目实测截图确认）。
> 因此依赖锁定在最后一批 MIT 版本：`primevue@4.5.5`、`@primevue/themes@4.5.4`、`primeicons@7.0.0`。
> 升级到 5.x 前必须先确认许可与是否需要购买密钥。

### 关于 npm 缓存（沙箱环境备注）

本仓库带有 `.npmrc`：`cache=./.npm-cache`。原因是某些受限环境（含本项目最初的开发沙箱）不允许写入 `~/.npm`，导致 `npm ci` 报 `EPERM`。
在普通开发机上**可以删除该文件**，npm 会回到默认缓存位置；`.npm-cache/` 已加入 `.gitignore`，可随时删除。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查：版本、迁移号、数据库路径、在线房间数 |
| `POST` | `/api/rooms` | 建房。body `{ nickname, roomName?, maxSeats? }`，返回玩家凭证（含重连凭证） |
| `POST` | `/api/rooms/:roomId/join` | 加入房间。body `{ nickname }`，返回玩家凭证 |
| `GET` | `/api/rooms/:roomId` | 邀请链接落地页预检：只返回房间公开信息（不泄露任何凭证） |
| `WS` | `/ws` | 同端口 WebSocket：订阅、心跳、动作、重连 |

**WebSocket 协议**（类型与 zod 校验集中在 `src/shared/protocol.ts`）

- 客户端 → 服务端：`room.join`、`seat.take`、`seat.leave`、`room.ready`、`game.start`、`game.action`、`heartbeat`
- 服务端 → 客户端：`room.snapshot`、`room.player_joined`、`room.player_left`、`hand.started`、`hand.state_changed`、`turn.started`、`hand.settled`、`room.error`、`connection.recovered`、`pong`
- 每条事件都携带完整「公共状态 + 本人私有状态」（`state` / `self`），客户端整体替换本地快照，重连与丢包都收敛到同一份服务端真相。
- 动作命令带 `requestId`（幂等去重）与 `expectedVersion`（过期即拒绝并回发最新快照）。
- **`state` 中永远不含他人未公开底牌**；`self.holeCards` 只发给本人。该约束有自动化测试覆盖（见下）。

## 测试

```bash
npm test     # Node 内置测试运行器，直接执行 TypeScript
```

覆盖内容：牌型/踢脚/低顺与循环顺、边池分层与余数分配、双人桌与三人桌盲位、最小加注与未满额 All-in 不重开加注、随机对局筹码守恒不变量、SQLite 迁移幂等；
以及真实 WebSocket 联机闭环：两个独立会话建房入座 → 打完一手摊牌 → **摊牌前不泄露对手底牌**（含反向对照）、重复请求幂等、过期版本拒绝、断线重连一致性与冒名凭证拒绝。

## 已知边界（当前阶段）

- 房间状态在内存，**进程重启不恢复牌局**；启动时会把上一次遗留的未关闭房间标记为 `closed`（快照恢复属第 4 阶段）。
- 首版固定桌规：2–9 人、初始 2000 筹码、盲注 10/20、每手 20 秒行动时间。
- 超时由服务端判定：无需跟注自动过牌，否则自动弃牌；断线不暂停全桌。

## 第三方 Skill 与许可

项目级 Skill 安装在 `.dsh/skills/` 与 `.agents/skills/`（`.gitignore` 未忽略，可按需保留或重建）。安装脚本见规格书 §8。

| Skill | 来源 | 许可 |
|---|---|---|
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills) | 随附 `LICENSE.txt` |
| web-design-guidelines | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | 仓库内**未提供** LICENSE 文件（仅复制了 `SKILL.md`） |
| pixijs 及子技能 | [pixijs/pixijs-skills](https://github.com/pixijs/pixijs-skills) | MIT |
| ui-ux-pro-max 等 | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | npm 包 `ui-ux-pro-max-cli@2.15.0` 声明 MIT |

牌面与筹码为自绘 CSS/SVG，未使用任何商业扑克产品的美术资产或品牌标志。`.skill-sources/`（第三方仓库源码缓存）已加入 `.gitignore`。

## 合规边界

虚拟筹码无法充值、提现、转让或兑换任何有价值物；本项目不提供任何真钱赌博功能。
