# Poker Room

朋友之间的**网页版德州扑克**：无需安装、开房即玩、断线可回桌。仅使用**虚拟、不可兑换筹码**，不含充值、提现、真钱下注或任何支付能力。

> 产品需求与验收标准见 [`docs/DeepSeek_Harness_德州扑克开发规格书.md`](docs/DeepSeek_Harness_德州扑克开发规格书.md)。本 README 只描述工程事实。
> **接手开发或换会话时先看 [`docs/CONTEXT.md`](docs/CONTEXT.md)**：当前完成度、代码地图、界面契约、已踩过的坑、验收基线（每次代码变更后同步更新）。

## 快速开始

```bash
npm ci
npm run build
npm start          # http://localhost:3000
```

首次启动会自动创建 `data/poker.sqlite` 并执行版本化迁移；重启数据保留。

主要流程：**大厅建房（或点朋友发来的邀请链接，也可以直接输入 6 位房间号）→ 直接进牌桌当旁观者 → 点空位确认买入落座 → 主持人开局**。
房间号是 6 位纯数字（邀请链接 `…/table/482913` 里那串就是它），方便口头或短信发给朋友。
牌桌上「离座」只保留座位与筹码（随时坐回），「退出房间」才释放座位；掉线超过宽限期（默认 5 分钟）自动释放座位。

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
| `npm run e2e` | Playwright + 真实 Chrome 端到端（先 build，并重置 `data/e2e.sqlite`）：单端口部署验收、两个独立上下文**建房 → 选座买入 → 打完一手**（含**摊牌前不泄露对手底牌**与**对局中刷新恢复**）、手机横屏无横向溢出、**牌桌小屏几何**、聊天（含**同人连续发言分组**）、**离座保留座位 / 退出释放座位**、观战与观战选座、**结算叠层不误弹**、顶栏收纳 |
| `npm run probe:table` | 牌桌几何探针（需先 `npm run dev`）：打印各视口下座位面板与底池/边池/公共牌/下注筹码的重叠像素，改小屏布局前后各跑一次 |
| `npm run check:deploy` | 对已启动的服务做单进程部署自检（网页/API/WebSocket 同端口、无外部服务依赖） |
| `npm run backup` | SQLite 备份与恢复演练（独立库：备份 → 校验 → 删除原库 → 恢复 → 重启验证） |

`npm run e2e` 使用 **Playwright**（`@playwright/test`，Apache-2.0）驱动两个相互隔离的浏览器上下文，
直接复用系统已安装的 Google Chrome（`channel: 'chrome'`，不额外下载浏览器内核），
并用独立端口 + 独立数据库启动一次生产进程，因此随时可跑、不影响正在服务的实例。
受限环境里 Chrome 自身沙箱可能无法初始化，故带 `--no-sandbox`（仅访问本机页面）。截图输出到 `artifacts/e2e/`。

部署、升级、备份与发布前检查清单见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

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

> **房间数上限**：服务器同时最多开放 **3 桌**（`MAX_ROOMS` 可覆盖，默认 3）。上限只约束新建；
> 已在进行的牌局不会被强制关闭，等其中一桌结束或被回收后才允许开新桌。大厅会显示「当前开放 x/3 桌」。
| `WS` | `/ws` | 同端口 WebSocket：订阅、心跳、动作、重连 |

**WebSocket 协议**（类型与 zod 校验集中在 `src/shared/protocol.ts`）

- 客户端 → 服务端：`room.join`、`seat.take`、`seat.leave`、`room.ready`、`game.start`、`game.action`、`chat.send`、`heartbeat`
- 服务端 → 客户端：`room.snapshot`、`room.player_joined`、`room.player_left`、`hand.started`、`hand.state_changed`、`turn.started`、`hand.settled`、`room.error`、`connection.recovered`、`chat.message`、`pong`
- 每条事件都携带完整「公共状态 + 本人私有状态」（`state` / `self`），客户端整体替换本地快照，重连与丢包都收敛到同一份服务端真相。
- 动作命令带 `requestId`（幂等去重）与 `expectedVersion`（过期即拒绝并回发最新快照）。
- **`state` 中永远不含他人未公开底牌**；`self.holeCards` 只发给本人。该约束有自动化测试覆盖（见下）。

## 测试

```bash
npm test     # Node 内置测试运行器，直接执行 TypeScript
```

覆盖内容：牌型/踢脚/低顺与循环顺、边池分层与余数分配、双人桌与三人桌盲位、最小加注与未满额 All-in 不重开加注、随机对局筹码守恒不变量、SQLite 迁移幂等；
真实 WebSocket 联机闭环：两个独立会话建房入座 → 打完一手摊牌 → **摊牌前不泄露对手底牌**（含反向对照）、重复请求幂等、过期版本拒绝、断线重连一致性与冒名凭证拒绝；
第 4 阶段可靠性：引擎快照往返一致性与损坏快照拒收、**单进程重启后从 SQLite 恢复同一手牌并继续打完**、重启后不重复结算、按持久化截止时间判定超时动作；
体验与节奏：服务器房间数上限、聊天广播/历史/限流/长度校验、全下逐张亮牌（含被抢先开下一手时结算不丢）、观战者无底牌无动作且可在空位后入座。

## 对局体验

- **聊天 / 房间日志**：`chat.send` 只在服务端校验长度（200 字）与频率（5 秒内最多 5 条），文本按纯文本下发；**不落库**（避免记录聊天内容），进入/重连时下发最近 50 条。聊天走**独立轻量事件**（不携带对局状态），既不推进牌局版本号、也不会打乱逐张亮牌的时序。
- **房间事件进日志**：入座、离座、开局、超时、结算等由服务端写成 `kind: "system"` 的消息，与玩家发言同列展示；刷新或换设备回来能看到期间发生了什么（重连不记日志，避免网络抖动刷屏）。
- **@ 提醒**：服务端按房间内真实昵称解析（最长昵称优先、排除自己），写入消息的 `mentions`；被提到的人看到金色描边 +「提到了你」文字标记，按钮名里也会报出条数。
- **消息搜索**：抽屉内按关键词过滤（命中昵称或正文），显示匹配条数，搜索时不再插入日期/未读分隔；无结果给专门空态。
- **手牌历史**：每房保留最近 20 手结算（重启后从 `hand_results` 重新载入），进入房间时随快照下发，抽屉里可查看每手的公共牌、底池、赢家与牌型。
- **提示音**：轮到你行动与结算时各有一声提示，用 Web Audio 现场合成（不引入任何音频素材），默认关闭、可在顶栏开关，状态本地持久化。
- **观战**：座位满了仍可进来观战（未落座人数上限 = 座位数 × 2，9 人桌 = 18 人）；观战者拿不到任何人的底牌、也没有可执行动作，有人离座后可以直接入座（本手不参与，下一手开始发牌）。
- **全下逐张亮牌**：所有人全下时不再一次性弹出 5 张公共牌，服务端按「翻牌 → 转牌 → 河牌」（每段 750ms）分段推送，最后才发结算事件；期间若有人抢先开下一手，上一手结算会被补发，结果绝不丢失。
- **邀请朋友**：房间号是 6 位纯数字，牌桌抽屉的「邀请」分节把房间号当桌牌摆出来，并给出只读邀请链接；「复制邀请链接 / 复制房间号」在 https / localhost 下写剪贴板，局域网 http 明文下（没有 `navigator.clipboard`）自动退到「已选中，按 Ctrl/⌘ + C 复制」，不会点了没反应。入口在宽屏顶栏「邀请」与窄屏「更多 → 邀请朋友」。
- **顶栏收纳**：≤1100px 时「邀请 / 规则 / 历史 / 聊天 / 提示音」收进「更多」菜单（≤820px 再隐藏阶段与连接状态文案）。修复前 1000px 以下顶栏会折成两行（61px → 121px），现在 1440→600px 全程单行。
- **聊天分组**：按日期（今天/昨天/具体日期）与 5 分钟以上的时间间隔插入分隔，打开面板时用「以下为新消息」标出未读起点（打开时记录，不随未读清零消失）。
- **观战者选座**：观战面板列出所有空位，可自选座位，而不是只能坐第一个。

## 持久化与重启恢复

- 引擎完整私有状态（牌堆位置、所有人底牌、筹码、轮次、行动权、行动截止时间、版本号）随命令**在同一个 SQLite 事务内**写入 `room_snapshots`；下发客户端的公共状态永远不含他人底牌。
- 进程重启时从快照恢复未关闭房间：`restored` 表示成功恢复数，`discarded` 表示快照缺失/损坏而被**安全关闭**的房间数（宁可关闭也不带半个状态对外服务）。
- 恢复后按**持久化的截止时间**接管行动计时：若截止时间已过，立即判定一次超时动作（自动过牌或弃牌），不会重新给满 20 秒，也不会级联自动打完一手。
- 结算记录按 `hand_id` 幂等写入，重启与重放都不会二次结算。

## 已知边界（当前阶段）

- 连接本身不跨重启保留（客户端会自动重连并收到 `connection.recovered` 快照）。
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
