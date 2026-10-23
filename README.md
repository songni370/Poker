# Poker Room

朋友之间的**网页版德州扑克**：无需安装、开房即玩、断线可回桌。仅使用**虚拟、不可兑换筹码**，不含充值、提现、真钱下注或任何支付能力。

> 本 README 只描述工程事实与验收基线。部署、升级与备份见 [`docs/DEPLOY.md`](docs/DEPLOY.md) 与 [`docs/SERVER_DEPLOY.md`](docs/SERVER_DEPLOY.md)。
>
> **注意**：`AGENTS.md` 与历史提交里引用的 `docs/DeepSeek_Harness_德州扑克开发规格书.md`、`docs/CONTEXT.md` **不在仓库中**。
> 当前有效的产品约束以 `AGENTS.md` 的「工作约定」一节为准；界面契约见本 README「对局体验」一节。

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
| `npm run build` | 构建前端 → `dist/client`，服务端 → `dist/server`（构建前自动生成牌桌几何 CSS） |
| `npm run gen:geometry` | 由 `src/client/components/table-geometry.ts` 生成 `src/client/styles/table-geometry.css` |
| `npm start` | **唯一生产进程**：`node dist/server/index.js` |
| `npm run typecheck` | `vue-tsc`（客户端）+ `tsc`（服务端） |
| `npm run lint` | ESLint |
| `npm test` | Node 内置测试运行器（原生跑 TypeScript，无额外框架） |
| `npm run e2e` | Playwright 端到端（先 build，并重置 `data/e2e.sqlite`，共 14 条）：单端口部署验收、两个独立上下文**建房 → 选座买入 → 打完一手**（含**摊牌前不泄露对手底牌**与**对局中刷新恢复**）、手机横屏无横向溢出、**牌桌小屏几何**、**本轮下注金额可见**、聊天（含**未读分隔线**与**同人连续发言分组**）、**离座保留座位 / 退出释放座位**、观战与观战选座、**结算叠层不误弹**、顶栏单行、房间号加房、邀请复制（含无剪贴板降级） |
| `npm run probe:table` | 牌桌几何探针（需先 `npm run dev`）：打印各视口下座位面板与底池/边池/公共牌/下注筹码的重叠像素，改小屏布局前后各跑一次 |
| `npm run check:deploy` | 对已启动的服务做单进程部署自检（网页/API/WebSocket 同端口、无外部服务依赖） |
| `npm run backup` | SQLite 备份与恢复演练（独立库：备份 → 校验 → 删除原库 → 恢复 → 重启验证） |

`npm run e2e` 使用 **Playwright**（`@playwright/test`，Apache-2.0）驱动两个相互隔离的浏览器上下文，
直接复用系统已安装的 Google Chrome（`channel: 'chrome'`，不额外下载浏览器内核），
并用独立端口 + 独立数据库启动一次生产进程，因此随时可跑、不影响正在服务的实例。
受限环境里 Chrome 自身沙箱可能无法初始化，故带 `--no-sandbox`（仅访问本机页面）。页面验收使用行为与布局断言，不生成截图。

> **工具分工**（`AGENTS.md` 约定）：Playwright 只用于**自动化回归测试**；
> 人工看页面、界面视觉验收与对局流程 dogfooding 一律使用 **ego-browser** 技能
> （先执行 `ego-browser skill` 获取当前版本用法），不要用 Playwright 或 Chrome 截图代替。

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

## 客户端代码地图

牌桌页是 `src/client/views/TableView.vue`（约 4700 行，仍在按阶段拆分），下面这些是独立模块，改对应内容时直接看这里：

| 文件 | 职责 |
|---|---|
| `views/TableView.vue` | 牌桌页面：编排各子组件与连接/提交逻辑（约 1870 行） |
| `components/TableTopBar.vue` | 顶栏：房间信息 + 配置/成员/声音/分享 |
| `composables/useSoundControl.ts` | 音效与背景音乐开关（含 AudioContext 手势解锁） |
| `components/HeroCockpit.vue` | 底部座舱：在座 / 离座托管 / 观战三种形态 + 操作区编排 |
| `components/JoinGate.vue` | 邀请链接落地页：昵称 + 房间密码 |
| `components/MemberPickerDialog.vue` | 房主「管理成员」：成员列表 + 就地二次确认移除 |
| `composables/useTurnTimer.ts` | 行动倒计时与下一手倒计时（rAF 驱动、按秒/按桶量化写 ref） |
| `composables/useTableCommands.ts` | 全部「发命令」逻辑：入座/换座/离座/退出/提交动作/开局/移除玩家 |
| `composables/useTableSession.ts` | 接入逻辑：凭证恢复、WebSocket 连接、进桌落地页表单 |
| `composables/useHandResult.ts` | 结算叠层：何时弹、刷新不重弹、本人底牌保底 |
| `composables/useSeatOverview.ts` | 座位概况：已入座数、空位数、首个空位、能否入座 |
| `composables/useHudPanels.ts` | HUD 三块浮层的**唯一状态源**：互斥展开、聊天已读锚点/滚动/输入法/@ 提醒 |
| `components/HudChatPanel.vue` | HUD 聊天浮层（通过 `useHudPanelsContext()` 复用父组件的实例） |
| `components/HudScorePanel.vue` | HUD 本桌计分板（排序与合计在组件内） |
| `components/HudHistoryPanel.vue` | HUD 手牌历史（模型来自 `history-model.ts`） |
| `components/InviteDialog.vue` | 邀请弹窗：房间号 + 邀请链接 + 复制降级 |
| `components/BuyInDialog.vue` | 买入 / 重新买入：金额校验与快捷档 |
| `components/ConfirmDialog.vue` | 通用二次确认（离座 / 退出） |
| `components/PokerTable.vue` | 桌面与座位环：座位极角定位、中央区（底池/街名/公共牌）、下注筹码 |
| `components/table-geometry.ts` | **牌桌几何唯一来源**：座位椭圆半径、座位宽、中央净宽、公共牌宽、舞台留白（按档位表） |
| `styles/table-geometry.css` | 上一条的**生成产物**（`npm run gen:geometry`），不要手改 |
| `components/PlayerSeat.vue` | 单个座位：昵称/筹码/本轮下注/动作标签/倒计时/角色徽章 |
| `components/ActionBar.vue` | 操作区：桌面档双舱布局 + 竖屏紧凑四键布局 |
| `components/HandResultOverlay.vue` | 结算叠层 |
| `components/history-model.ts` | 手牌历史的纯函数展示模型（排序、本人高亮、摊牌明细） |
| `components/PlayingCard.vue` | 扑克牌面（象牙纸质感、左上大角标 / 右下小角标） |
| `views/LobbyView.vue` | 大厅：建房 / 按号加入 |
| `stores/chat.ts` | 聊天状态：消息、未读数、已读锚点（驱动「以下为新消息」分隔线） |
| `styles/theme.css` | 全局 token：色板、间距、圆角、字体，以及拟物风材质变量（木纹/真皮/呢绒/黄铜/香槟金） |
| `styles/hud-panels.css` | HUD 三块浮层共用的样式（胶囊按钮、浮层底板、消息行）——**全局表，不是 scoped** |
| `styles/hero-cockpit.css` | 底部座舱与观战面板样式（含竖屏/超短屏压缩） |
| `styles/table-top-bar.css` | 顶栏样式（单行约束、房间名省略、声音浮层） |
| `styles/join-gate.css` | 进桌落地页样式 |
| `styles/confirm-dialog.css` | 二次确认类弹窗与成员列表样式 |

**改界面时注意**：桌面 / 横屏与手机竖屏是两套布局，共用同一批组件，靠媒体查询与 `table-geometry.ts` 的档位切换；
改任何尺寸先改档位表，再跑 `npm run probe:table` 与 `npx playwright test tests/e2e/poker-room.spec.ts -g 几何`。

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

> **PrimeVue 版本说明**：PrimeVue **5.x 及其配套 `primeicons@8` 已改为 PrimeTek 商业许可**，未配置许可证时会在生产界面右下角常驻 “Invalid PrimeVue License” 水印（本项目曾在生产界面观察到）。
> 因此依赖锁定在 MIT 版本：`primevue@4.5.5`、`@primeuix/themes@2.0.3`、`primeicons@7.0.0`。
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

> `npm test` 中「逐张亮牌期间被抢先开下一手」是**时序敏感**用例，偶发超时失败（单跑与整轮重跑均通过）。遇到时先单独重跑确认，不要误判为功能回归。

## 对局体验

- **聊天 / 房间日志**：`chat.send` 只在服务端校验长度（200 字）与频率（5 秒内最多 5 条），文本按纯文本下发；**不落库**（避免记录聊天内容），进入/重连时下发最近 50 条。聊天走**独立轻量事件**（不携带对局状态），既不推进牌局版本号、也不会打乱逐张亮牌的时序。
- **房间事件进日志**：入座、离座、开局、超时、结算等由服务端写成 `kind: "system"` 的消息，与玩家发言同列展示；刷新或换设备回来能看到期间发生了什么（重连不记日志，避免网络抖动刷屏）。
- **@ 提醒**：服务端按房间内真实昵称解析（最长昵称优先、排除自己），写入消息的 `mentions`；被提到的人看到高亮描边 +「提到了你」文字标记，聊天按钮名里也会报出条数。点击对方昵称可把 `@昵称` 插入输入框。
- **聊天面板**：聊天是牌桌左上角的 **HUD 浮层**（不是抽屉）。点「聊天」胶囊展开，再点一次或点面板外收起；关闭时记录已读锚点，下次打开用「以下为新消息」标出这期间的新消息；同一人连续发言只显示一次昵称（`is-continuation`），@ 提醒始终单独成组。
- **手牌历史**：每房保留最近 20 手结算（重启后从 `hand_results` 重新载入），进入房间时随快照下发；牌桌右上角「手牌历史」胶囊里可查看每手的公共牌、底池、赢家与牌型（展示模型见 `src/client/components/history-model.ts`）。
- **提示音**：轮到你行动与结算时各有一声提示，用 Web Audio 现场合成（不引入任何音频素材），默认关闭、可在顶栏开关，状态本地持久化。
- **机器人陪练**：房主可点「加机器人」拉一个虚拟玩家入座，**一个人也能把整条流程跑通**（下注 → 摊牌 → 结算 → 下一手）。机器人跑在服务端进程内（没有 WebSocket），由服务端在轮到他时自动出牌，走的是和真人完全一样的规则路径（筹码守恒、边池、亮牌都适用）。决策只喂「自己的底牌 + 公共牌」，从类型上就看不到别人的牌。
- **观战**：座位满了仍可进来观战（未落座人数上限 = 座位数 × 2，9 人桌 = 18 人）；观战者拿不到任何人的底牌、也没有可执行动作，有人离座后可以直接入座（本手不参与，下一手开始发牌）。
- **全下逐张亮牌**：所有人全下时不再一次性弹出 5 张公共牌，服务端按「翻牌 → 转牌 → 河牌」（每段 750ms）分段推送，最后才发结算事件；期间若有人抢先开下一手，上一手结算会被补发，结果绝不丢失。
- **邀请朋友**：房间号是 6 位纯数字，顶栏「分享」打开邀请弹窗，把房间号当桌牌摆出来，并给出只读邀请链接；「复制链接 / 复制」在 https / localhost 下写剪贴板，局域网 http 明文下（没有 `navigator.clipboard`）自动退到「已选中，按 Ctrl/⌘ + C 复制」，不会点了没反应。
- **顶栏**：只保留房间信息、盲注、连接状态、「配置」（房主）与「分享」；聊天 / 计分板 / 手牌历史是桌面上的 HUD 胶囊，不再塞进顶栏。1440→600px 全程单行（高度 < 80px，有 e2e 断言守护）。
- **本轮下注**：每个在局玩家的座位面板上**始终**显示本轮已投入的筹码（暖金色角标 + 迷你筹码），另有动作标签（`跟注 900` / `下注 1600` / `加注到 2000` / `全下 1200` / `小盲 10`）；本人底部筹码胶囊旁也有「本轮 N」。这是判断跟注额与决定加注的直接依据，竖屏与桌面一致。

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
