# 交接文档（给下一个会话）

> 面向对象：接手的 AI 助手 / 开发者。目标：**5 分钟看懂现状、10 分钟能改代码、不重犯已经踩过的坑**。
> 最后更新：2026-09-21（对应提交 `217daf0`）
> 产品需求与验收标准以 [`DeepSeek_Harness_德州扑克开发规格书.md`](./DeepSeek_Harness_德州扑克开发规格书.md) 为准，本文只记录**工程事实与经验**。

---

## 0. TL;DR

- 一个 **Web 联机德州扑克**（虚拟不可兑换筹码），朋友之间开私人房玩。
- 规格书 §13 的 **第 0–5 阶段已全部完成**，另外补做了聊天/房间日志、手牌历史、提示音、全下逐张亮牌、多桌上限、观战优化、顶栏收纳等。
- 硬约束（不可违反）：**一个仓库 / 一个 `package.json` / 一个 Node 进程 / 一个端口 / 一次部署**；SQLite 单文件；**禁止** Redis / MySQL / 独立前端部署 / 微服务 / 生产双进程。
- 现状：`lint`、`typecheck`、`30 项单测/集成`、`6 项真实浏览器 e2e`、部署自检、备份演练**全部通过**；工作区干净。

最快跑起来：

```bash
cd /Volumes/MyFiles/Projects/FSPoke
npm ci && npm run build && npm start     # http://localhost:3000
npm run dev                              # 开发：Vite 5173 + API 3000（两个进程，仅开发期）
npm test && npm run e2e                  # 全量验收
```

---

## 1. 环境与依赖（都是实际验证过的）

| 项 | 事实 |
|---|---|
| Node | **v24.18.0**（`node:sqlite` + 原生执行 `.ts` 都需要 ≥ 24） |
| npm | 11.16.0，仓库内 `.npmrc` 设了 `cache=./.npm-cache` |
| SQLite | **`node:sqlite` 标准库**，没有 better-sqlite3，也没有独立数据库进程 |
| 测试 | **`node --test` 直接跑 `.ts`**，没有 vitest/jest/tsx |
| 客户端 | Vue 3.5 + vue-router 5 + Pinia 4 + **PrimeVue 4.5.5** + Vite 8 |
| 服务端 | Fastify 5 + `@fastify/static` + `@fastify/websocket` + zod 4 |
| e2e | `@playwright/test` 1.63，**复用系统已装 Chrome**（`channel: 'chrome'`），不下载内核 |
| TS 构建 | 源码用 `.ts` 扩展名导入，靠 `rewriteRelativeImportExtensions` 在产物里改写成 `.js` |

### 1.1 两个环境陷阱

1. **`.npmrc` 的 `cache=./.npm-cache`**：本项目最初的沙箱环境不允许写 `~/.npm`，`npm ci` 会报 `EPERM`。
   普通机器**可以删掉这个文件**（`node_modules` 与缓存目录都已 gitignore）。
   如果环境变量 `npm_config_cache` 被设置，它会覆盖 `.npmrc`，此时要显式加 `--cache ./.npm-cache`。
2. **PrimeVue 许可证**：`primevue@5.x` 与 `primeicons@8.x` 已改为 PrimeTek **商业许可**，未配置 key 时生产界面右下角会常驻
   “Invalid PrimeUI License” 水印（本项目实测截图确认过）。因此依赖**锁定在最后一批 MIT 版本**：
   `primevue@4.5.5` / `@primevue/themes@4.5.4` / `primeicons@7.0.0`。**升级 5.x 前必须先确认许可。**

---

## 2. 当前完成度

### 2.1 规格书阶段

| 阶段 | 状态 | 关键交付 |
|---|---|---|
| 0 工程初始化 | ✅ | 单仓库单进程、SQLite 自动建库与版本化迁移、`/api/health`、同端口静态托管 |
| 1 高保真界面 | ✅ | 大厅/等待区/牌桌、2–9 人环桌、全状态模拟数据、响应式基线 |
| 2 纯规则引擎 | ✅ | 洗牌/盲注（含双人桌例外）/最小加注/未满额 all-in 不重开加注/边池/平分/状态机 |
| 3 联机闭环 | ✅ | 建房·邀请·入座·准备·开局·动作·重连；服务端权威状态、私有数据过滤、幂等、过期版本拒绝 |
| 4 重连与持久化 | ✅ | 事务化快照写入、单进程重启恢复、按持久化截止时间判定超时、重复结算为 0 |
| 5 UI 质量与发布候选 | ✅ | 规范审查与修复、手机布局、Playwright 端到端、SQLite 备份恢复演练、部署说明与自检 |

### 2.2 阶段之外补做的功能

- **聊天 / 房间日志**：玩家发言 + `kind:"system"` 房间事件（入座/离座/开局/超时/结算），未读计数、日期与时间分组、未读分隔线、**@ 提醒**（服务端按真实昵称解析并校验）、**消息搜索**、@ 插入按钮。
- **手牌历史**：每房最近 20 手，重启后从 `hand_results` 重新载入，抽屉内查看公共牌/底池/赢家/牌型。
- **提示音**：Web Audio 现场合成（**不引入任何音频素材**），默认关、顶栏开关、状态本地持久化。
- **全下逐张亮牌**：服务端按「翻牌→转牌→河牌」每段 750ms 分段推送，最后才发结算；被抢先开下一手时结算会补发。
- **多桌上限**：服务器全局最多同时开放 **3 桌**（`MAX_ROOMS` 可覆盖）；大厅显示「当前开放 x/3 桌」。
- **观战**：座位满了仍可进入观战（观战位上限 = 座位数），观战者拿不到任何底牌、无合法动作，可**自选空位**入座。
- **顶栏收纳**：≤1100px 把二级操作收进「更多」菜单，≤820px 再隐藏阶段与连接状态文案；1440→600px 顶栏始终单行。

---

## 3. 代码地图

```
src/shared/      (2 文件)  poker.ts（牌/牌型/桌规常量）  protocol.ts（zod 命令 + 事件类型 + 错误码）
src/engine/      (5 文件)  deck.ts  evaluate.ts  pots.ts  table.ts（状态机 + 快照）  index.ts
src/server/      (7 文件)  index.ts（唯一生产入口）  app.ts  routes.ts（HTTP）  ws.ts
                           rooms.ts（RoomManager/RoomRuntime，最核心）  repo.ts（SQLite 仓储）  db/index.ts（迁移）
src/client/     (21 文件)  main.ts router.ts sound.ts
                           stores/{room,game,connection,chat}.ts
                           net/session.ts（HTTP + WebSocket 单例、重连、时钟同步）
                           views/{Lobby,Room,Table,Error}View.vue
                           components/{PokerTable,PlayerSeat,PlayingCard,CommunityCards,ActionBar,ConnectionBanner,HandResultOverlay}.vue
                           dev/mock.ts（开发期模拟场景，生产构建不打包）
tests/           (8 文件)  helpers.ts + db/engine/features/integration/recovery.test.ts + e2e/{poker-room,features}.spec.ts
scripts/         (3 文件)  dev.mjs（并行起 Vite+Fastify）  deploy-check.mjs  backup-drill.mjs
migrations/      (1 文件)  001_init.sql
docs/                      规格书 + 本文件 + DEPLOY.md
```

**关键数据流**：浏览器 → 同源 HTTP（建房/加房）+ WebSocket（`/ws`）→ `RoomManager.execute()`（**每房一条串行队列**）
→ `HoldemTable`（唯一筹码真相）→ 同一 SQLite 事务写 `command_receipts` / `players` / `hand_results` / `room_snapshots`
→ `publish()` 向每个在线成员各发一份「公共状态 + 本人私有状态」。

---

## 4. 关键设计决策与**已踩过的坑**（最重要的一节）

1. **聊天必须是「轻量事件」**：`chat.message` 不携带 `state`/`self`，且**不在** `SERVER_EVENT_TYPES` 里。
   曾经把它做成状态事件，结果它抢在结算/亮牌事件之前把完整牌面（含 `revealedCards`）发了出去，
   导致逐张亮牌序列变成 `0→5→3→4`，并破坏「摊牌前不泄露对手底牌」的时序。**改回去就会重犯。**
2. **版本号必须在写快照之前推进**（`bumpVersion` → `scheduleTurn` → 事务写库 → `publish`）。
   否则落库版本比广播版本慢一步，重启恢复后客户端看到版本倒退。
3. **`npx playwright test` 不会重新构建**，测的是 `dist/client` 旧产物。
   必须用 **`npm run e2e`**（内部先 `npm run build`）。这一条踩过一次，浪费了一轮排查。
4. **e2e 服务器把 `MAX_ROOMS` 放宽到 20**：整套用例共用一个服务端，多用例各自建房会撞上「最多 3 桌」的产品上限。
   上限本身由 `tests/features.test.ts` 覆盖。
5. **模拟场景（`dev/mock.ts`）只在开发模式可用**（`import.meta.env.DEV`）。要测 9 人桌/断线/摊牌等模拟态，
   必须 `npm run dev` 后开 **http://localhost:5173**；生产构建里没有 mock。
6. **开发与生产的进程模型不同**：`npm run dev` = Vite(5173) + Fastify(3000) 两个进程；生产 = 单进程 3000。
   开发时若打开 3000 看到的是 `dist/client` 旧构建，不会热更新。
7. **Playwright 的 Chrome profile 放在系统临时目录的固定路径**（`<tmp>/poker-e2e-chrome-profile`）。
   曾经每次运行新建 `--user-data-dir`，macOS 会把它当成全新实例，Dock 里不停冒新图标；
   同时 Chrome 要 `detached: true` 启动、按**进程组**回收，否则 renderer/crashpad 会变孤儿进程。
   受限环境里 Chrome 自身沙箱无法初始化（会 SIGTRAP 退出），所以带 `--no-sandbox`。
8. **座位占用看 `HoldemTable.isSeatAvailable()`**，不要直接判断 `seatAt()` 是否存在：
   手牌进行中离座的玩家会以 `pendingLeave` 保留到本手结束（筹码还在池里、牌已弃），
   那个座位对新玩家来说是空的，否则会出现「看起来空着却坐不进去」。
9. **引擎快照校验按 `phase` 区分**：`waiting` 阶段牌堆本来就是空的，不能要求「牌数 = 52」，
   否则从未开过手的等待房间重启时会被误判为损坏快照并关闭（已修，有测试）。
10. **聊天不落库**（刻意选择：不记录聊天内容）。重启后聊天清空、手牌历史保留。
    若要改成都持久化，需要单独设计保留策略与隐私说明。
11. **`src/server/app.ts` 启动时先 `restoreRooms()`**（不再有 `closeStaleRooms`）：
    快照缺失/损坏的房间会被**安全关闭**，日志里报 `restored` / `discarded` 计数。
12. **不要动用户在 3000 端口自己起的服务**：测试请用独立端口 + 独立 `DATABASE_PATH`
    （`playwright.config.ts` 用 3300 / `data/e2e.sqlite`；演练脚本用 3200/3400）。

---

## 5. 命令与验收基线

```bash
npm run lint         # ESLint：0 error
npm run typecheck    # vue-tsc（客户端）+ tsc（服务端）
npm test             # node --test：30 项（规则/边池/不变量/联机/重启恢复/房间上限/聊天/亮牌/观战）
npm run e2e          # 先 build，再跑 6 项 Playwright（真实 Chrome）
npm run check:deploy # 对已启动的服务做单进程部署自检（8 项，零依赖，可在生产机跑）
npm run backup       # SQLite 备份/恢复演练（9 项：备份→校验→删库→恢复→重启验证）
npm run dev          # 开发（Vite 5173 + API 3000）
npm start            # 生产单进程（默认 127.0.0.1:3000，生产用 HOST=0.0.0.0）
```

最近一次全绿的真实输出：

```
npm test   → ℹ tests 30  ℹ pass 30  ℹ fail 0
npm run e2e → 6 passed (22.3s)
check:deploy → 通过（共 8 项检查）      backup → 通过（共 9 项检查）
```

### 测试覆盖清单（30 项单测/集成）

规则：低顺与循环顺、牌型排序、踢脚与平分、边池分层与余数、双人桌盲位、三人桌行动顺序、最小加注、
未满额 all-in 不重开加注、非法操作不改状态、三家全下边池分配、弃牌收池、随机对局筹码守恒不变量。
可靠性：快照往返与损坏拒收、重启恢复一致并继续打完、不重复结算、过期截止时间自动动作、等待房间存活。
联网：联机闭环（含**摊牌前不泄露对手底牌**+反向对照）、连续两手、闲置回收、幂等与过期版本、断线重连与冒名拒绝。
功能：房间上限、聊天（广播/历史/限流/长度/@ 解析/系统日志）、全下逐张亮牌时序、抢跑不丢结算、观战权限与入座。

### 测试覆盖清单（6 项浏览器 e2e）

部署验收（单端口网页+API+WS）、双会话打完一手且摊牌前不泄露底牌、对局中刷新恢复、
手机横屏无溢出、聊天（未读/历史/搜索/@/系统消息）、观战（无底牌/无操作区/空位后自选座位入座）、顶栏收纳回归。

---

## 6. 已知问题与待办（按优先级）

1. **聊天无消息分组折叠**：同一人连续发言仍逐条显示。
2. **观战面板座位选择**在 9 人桌 + 窄屏会挤成多行（当前是一排小按钮）。
3. **9 人桌 + 极矮横屏（740×360）**仍有几何重叠：底池已提到最上层并加不透明底衬（始终可读），
   公共牌区重叠约 6px；彻底消除需要为 9 人桌做专门的矮屏环形布局。
4. **多机扩容未做**：房间是内存 + 单文件 SQLite。规格书要求确需扩容时**另立架构设计**，且不得擅自引入 Redis。
5. **发牌动效只做了淡入**：按规格书「确认 CSS/SVG 无法满足才引入 PixiJS」判断，CSS 足够，未引入 PixiJS。
6. 房间上限是**服务器全局 3 桌**（不是每人 3 桌）——这是用户明确选择的口径，改动前先确认。
7. `npm run e2e` 依赖系统 Chrome；目标机没有 Chrome 时用 `npm run check:deploy` 代替线上自检。

---

## 7. 协作约定

- **先读 `AGENTS.md` 与规格书**；禁止真钱赌博/充值/提现/可兑换筹码。
- 界面设计用 `ui-ux-pro-max` + `frontend-design`，界面检查用 `web-design-guidelines`（技能已装在 `.dsh/skills`、`.agents/skills`）。
- 每个阶段开始前：检查项目现状 → 列出**实际发现**的 Skill（没发现就说没发现，不许假装加载）→ 给短计划。
- 每阶段结束按规格书 §14 用简体中文汇报：①目标 ②已加载 Skills ③方案 ④修改文件 ⑤命令与**真实**结果 ⑥验收清单 ⑦已知风险 ⑧下一步。
- **不得虚报测试通过**；跑不了就说明原因。
- 改动只限本项目，不碰无关项目/部署配置；未经批准不安装依赖、不执行破坏性命令。

---

## 8. 提交历史（最新在前）

```
217daf0 聊天功能补全：房间日志 + @ 提醒 + 消息搜索
713a27e 继续优化：顶栏收纳、观战选座、聊天分组，并完成无障碍与性能复核
2934b0a 体验与节奏补全：聊天 / 手牌历史 / 提示音 / 全下逐张亮牌 / 多桌上限与观战
4c82c80 第 5 阶段收尾：矮屏座位紧凑化与底池层级修复
ab41757 第 5 阶段：UI 质量与发布候选
cae4b12 第 4 阶段：SQLite 事务化快照与单进程重启恢复
ed0c66b 小屏座位越界修复 + e2e 的 Chrome profile 移出仓库
0a31995 e2e：不再为每次运行新建 Chrome profile，避免 macOS Dock 反复出现新图标
b4feb09 修复 npm run dev：接上 scripts/dev.mjs，同时启动 Vite 与 Fastify
ec8a2de 第 0–3 阶段：工程骨架、规则引擎、高保真界面与联机闭环
```

---

## 9. 快速排错

| 现象 | 先看这里 |
|---|---|
| `npm ci` 报 `EPERM`/缓存写不进去 | 见 §1.1；用 `--cache ./.npm-cache` 或删掉 `.npmrc` |
| 页面右下角出现 “Invalid PrimeVue License” | PrimeVue 被升到了 5.x，按 §1.1 退回 MIT 版本 |
| 改了代码但页面没变 | `npm run e2e` 会先 build；手工 `npx playwright test` 不会。开发时用 5173 |
| 开了 4 个房间失败 | 这是产品上限（默认 3 桌），见 §6.6 |
| 亮牌顺序错乱 / 底牌提前出现 | 检查 `chat.message` 是否又被塞进了状态事件，见 §4.1 |
| 座位「空着却坐不进去」 | 用 `isSeatAvailable()`，见 §4.8 |
| 重启后房间全被关掉 | 看启动日志的 `restored` / `discarded`；快照损坏时会被安全关闭（引擎快照校验见 §4.9） |
| macOS Dock 里 Chrome 图标越堆越多 | e2e 用了固定 profile 且按进程组回收；若仍有残留图标，`killall Dock` 可清显示残留 |
