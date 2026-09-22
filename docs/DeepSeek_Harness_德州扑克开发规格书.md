# Web 联机德州扑克｜DeepSeek Harness 开发规格书

> 版本：v1.4｜2026-09-22｜用途：DeepSeek Harness 分阶段开发与验收
>
> 开发边界：以**虚拟、不可兑换筹码**的休闲社交游戏为首版目标；不开发充值、提现、真钱下注、代币兑换、赌博营销或支付结算。
>
> **变更记录（用户后续明确要求的偏离，已实现并验收；工程细节见 `docs/CONTEXT.md`）**
> - v1.4｜移动端：**手机端只做竖屏**。横屏（orientation: landscape 且高 ≤560px）显示整屏
>   「请竖屏使用」遮罩、不渲染牌桌；几何验收档为 1440×900 / 1280×720 / 390×844 / 360×740，
>   横屏两档（844×390 / 740×360）只由 e2e 验「不横向溢出 + 出现遮罩」。
>   **取代**首版验收标准里的「桌面端及手机横屏可操作」、P1 的「横屏主体验」与 §3.3 的横屏优先说法。
> - v1.4｜房间：**房间号改为 6 位纯数字**（原为短随机串），邀请链接形如 `/table/482913`，
>   大厅可直接按号加入；服务器同时最多 **10 桌**；全员退出 / 没人落座 / 5 分钟没有玩家操作
>   即自动关闭房间（可用 `IDLE_ROOM_MS` 调整）。
> - v1.4｜邀请：牌桌抽屉新增「邀请」分节（房间号 + 邀请链接 + 一键复制），入口在宽屏顶栏「邀请」
>   与窄屏「更多 → 邀请朋友」；局域网 http 明文下没有剪贴板 API 时退到「已选中，按 Ctrl/⌘ + C 复制」。
> - v1.4｜操作入口：顶栏的「开始牌局 / 退出房间」移到底部操作区；「离座」（保留座位与筹码）
>   与「退出房间」（释放座位）的文案与图标明确区分。
> - v1.3｜房间流程：**删除等待区页面**（原 §3.2 第 2 条 `/room/:roomId`）。填完昵称后直接进牌桌，
>   此时未落座（游客/旁观者），桌子上显示剩余座位；点空位 → 确认买入 → 落座，等待下一手进入牌局。
>   邀请链接因此改为 `/table/:roomId`。开局仍由主持人触发（原 §4「主持人开始」不变）。
> - v1.3｜买入：起始筹码不再固定为 2,000 的单一值。**买入上限由主持人在建房里自定义**（默认 2,000），
>   实际买入额由玩家在「10 个大盲 ～ 上限」之间选择，步进等于小盲（10/20 时即 200–2,000、步进 10），
>   服务端做范围收敛与步进取整。筹码仍是虚拟、不可兑换、不可转让。
> - v1.3｜座位语义：「离座」只保留座位与筹码（只有本人能坐回），只有「退出房间」才释放座位并离开房间；
>   掉线超过宽限期（默认 5 分钟）自动释放座位。原 §5「断线保留座位到本局结束或宽限期」仍成立。

## 0. 如何使用本文件（先读）

本文件既是产品需求文档，也是 AI 开发助手的执行约定。把它放到新项目的 `docs/POKER_SPEC.md`，在项目根目录启动 DeepSeek Harness，并把这个项目设为工作区。第一次对话请直接使用第 15 节的“启动总指令”；随后按第 13 节逐阶段执行，每阶段必须提交可运行成果与验证记录。**不要让 AI 开发助手一次性实现所有功能。**

**已核实的 Harness 操作**：`npx @deepseek-ai/dsh web` 启动 Web UI；在 Settings → Models 保存 DeepSeek API Key；选择工作区后才能开始会话。DeepSeek Harness 处于 developer preview，接口可能发生不兼容更新。安全起见，使用独立项目、最小权限与代码备份，不向 Agent 暴露生产支付密钥。[1][2][3]

**重要纠偏**：之前提供的安装命令以 Codex 为目标；DeepSeek Harness 会读取项目级 `.dsh/skills/`、`.agents/skills/` 及用户级 `~/.dsh/skills/` 等目录。**不要假设装在 `~/.codex/skills/` 的 Skill 会被 Harness 自动读取**。[4]

## 1. 产品定位与验收目标

**产品代号**：Poker Room（可后期改名）。**目标用户**：朋友之间通过网页分享链接进行 2–9 人德州扑克娱乐局。**核心价值**：无需安装、低门槛开房、低延迟操作、断线可回桌、移动端可用。

**用语说明**：本文所说“首版可运行版本”，是指第一版上线后就能让朋友通过浏览器创建房间、加入房间并完整打完一手牌；不是只有页面效果图，也不是尚不能完成对局的演示程序。后续功能再分阶段增加。

**首版交付验收标准**：一位玩家创建私人房间并分享邀请链接；至少两个独立浏览器会话加入并入座；服务端正确完成一整手德州扑克（发牌 → 四轮下注 → 摊牌或全员弃牌 → 分池/结算 → 下一手）；断线并在宽限期内返回能拿到一致状态；不得泄露其他玩家底牌；桌面端可操作、手机端竖屏可操作（**手机横屏已在 v1.4 取消，改为「请竖屏使用」遮罩**，见变更记录）。

**首版暂不开发**：公开赛事系统、AI 机器人、俱乐部后台、真钱/可提现筹码、支付、排行榜商城、语音视频、复杂角色资产、账户交易功能。身份先采用访客昵称 + 房间凭证；未来再扩展账号体系。

## 2. 功能范围及优先级

**优先级说明**：P0＝首版必须完成；P1＝首版完成后优先补充的体验功能；P2＝后续版本再考虑。

| 级别 | 模块 | 首版开发范围与验收标准 |
|---|---|---|
| P0 | 首页/大厅 | 创建私人房间、通过邀请链接加入、房间不存在/满员提示 |
| P0 | 房间/座位 | 2–9 座布局、入座/离座、准备、主持人开始、观战 |
| P0 | 实时牌局 | 牌桌、底牌、公共牌、底池、筹码、庄位、行动计时和系统提示 |
| P0 | 操作 | 弃牌（Fold）、过牌（Check）、跟注（Call）、下注（Bet）、加注（Raise）、全下（All-in）；非法操作禁用 |
| P0 | 核心规则 | 轮次推进、最小加注、边池、摊牌和赢家分配 |
| P0 | 网络一致性 | 重连快照、重复消息去重、过期动作拒绝、断线超时策略 |
| P1 | 体验 | 简洁发牌/筹码动画、声音开关、手牌历史摘要、聊天 |
| P1 | 移动端 | **竖屏主体验**与横屏「请竖屏使用」引导（v1.4 起；原「横屏主体验」已废止）；安全区域和触控优化 |
| P2 | 扩展 | 账号、好友、战绩、主题商店；不纳入首次交付 |

## 3. 界面与视觉规范

### 3.1 设计方向

现代、克制、有游戏质感的扑克客户端：**炭黑背景 + 深绿桌布 + 哑金强调 + 高对比文字**。不要套用管理后台视觉、荧光渐变、厚重玻璃拟态，也不要复制 PokerStars/GGPoker 等商业产品的品牌标志或原始美术资产。采用自行绘制 SVG/原创牌面与可商用字体；第三方素材记录许可。

| 设计变量 | 色值 | 用途 |
|---|---|---|
| `--bg` | `#10151B` | 游戏背景 |
| `--felt` | `#164B40` | 牌桌主色 |
| `--gold` | `#D4B16A` | 庄位、焦点、底池 |
| `--text` | `#F2F1EA` | 主要文字 |
| `--muted` | `#AAB6BE` | 次级提示 |
| `--action` | `#3084DA` | 主要动作按钮 |
| `--positive` | `#176C53` | 可继续的动作 |
| `--danger` | `#C54A50` | 弃牌/错误的谨慎提示 |

统一 8px 间距基线，圆角 8/12/20px，牌桌自适应等比缩放但按钮和牌面文本设最小可读尺寸。颜色不能是唯一区分手段：轮到玩家必须同时显示头像光环、`YOUR TURN` 文本和进度条；红黑牌花必须包含花色字形。动效优先 opacity/transform，支持 `prefers-reduced-motion`。

### 3.2 页面地图

1. `/`：品牌主视觉、创建房间与加入房间；首次访问允许填写昵称。
2. ~~`/room/:roomId`：私人房间等待区~~ → **v1.3 已按用户要求删除**：改为建房/邀请链接直接进
   `/table/:roomId`（未落座时是旁观者，自己选座位并确认买入；规则摘要与邀请链接都在牌桌抽屉里）。
3. `/table/:roomId`：核心实时牌桌；直接刷新与重连必须恢复。
4. 牌桌内叠层：设置、操作说明、手牌结算、连接状态、退出确认。
5. 未授权或错误页：链接过期、房间已满、被房主移除、版本不兼容。

### 3.3 桌面牌桌信息层级

顶部：房间名、盲注、连接状态、设置与退出。中心：椭圆桌面、2–9 位玩家槽位、庄家按钮、各人本轮下注、总底池、五张公共牌。底部：自己的两张底牌、自己剩余筹码、轮到自己倒计时、下注数值选择与动作区。侧边抽屉：聊天、手牌历史、规则；默认不抢占牌桌宽度。

动作按钮按状态显示：例如当前无需跟注时显示 `CHECK / BET / FOLD`；需要跟注时显示 `FOLD / CALL X / RAISE`。All-in 要显示对应确切金额并提供必要的误触防护；禁用原因可解释。下注提供数字输入、滑块或快捷额度按钮（如 1/2 pot、pot），所有数值都由服务端校验。

### 3.4 响应式与状态清单

桌面目标布局：1440×900 与 1280×720；移动端只做竖屏，优先测试 390×844 与 360×740（v1.4 起；横屏 844×390 / 740×360 只验「不横向溢出 + 出现竖屏遮罩」）。小屏不遮挡手牌、玩家下注、底池和操作。横屏时给出「请竖屏使用」整屏遮罩、不渲染牌桌（v1.4 起）。覆盖：空房、等待、倒计时、自己的回合、他人的回合、玩家 All-in、摊牌、单赢家、多人平分、连接中、已断线、重连成功、超时自动弃牌、被踢出、房间关闭。

## 4. 德州扑克规则与服务端状态机

**默认游戏**：No-Limit Texas Hold'em，52 张标准牌、无大小王；2–9 人桌；虚拟筹码整数存储，初始 2,000，盲注 10/20（后续可配置，首版固定）；不允许负筹码或溢出。所有钱数在游戏内部称“chips”，不要与真实货币混淆。决定按钮庄位、大小盲与每轮首个行动者时，必须正确处理 双人桌（两人）例外。

牌局状态：`WAITING → POST_BLINDS → DEAL_HOLE → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → SETTLEMENT → NEXT_HAND`。单人存活则可在任一下注轮直接 `SETTLEMENT`；所有仍参与者都 All-in 时无需等待操作，但仍须按顺序展示剩余公共牌后结算。

核心规则：服务端洗牌与发牌（使用系统级安全随机源和无偏洗牌）；每位玩家仅收到自己的底牌，公共信息走公共状态；行动者按座次与盲位正确决定；每轮下注完成条件需要考虑已弃牌、All-in、已跟平以及完整加注后的重新行动；未满额 All-in 加注通常不重新开放已行动玩家的再次加注权，需用明确的 `raiseReopened` 状态和测试覆盖；最小加注与首次下注规则一致。结算时计算合法 5 张最大牌型、同牌型 踢脚牌、平分、边池以及余数筹码分配（固定规则并记录测试）。

**牌型优先级**：同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌。A 可以在 A-2-3-4-5 中作低顺，但不允许循环顺子。每个边池只让该池合格玩家参加分配。弃牌玩家此前投入仍进入底池，但失去争夺资格。

**首版回合超时规则**：默认每人 20 秒，时间以服务端为准；无需跟注则自动 Check，否则自动 Fold；断线不暂停全桌；重连重发脱敏快照，服务端保留座位到本局结束或房间规则规定的宽限期。所有规则与超时策略需在房间页面公开展示。

## 5. 系统架构（一体化、单进程、SQLite）

**不可妥协的架构约束**：一个 Git 仓库、一个 `package.json`、一个 Node.js 进程、一个 HTTP 端口、一次构建、一次部署。**严禁**引入 Redis、MySQL/MariaDB、PostgreSQL、独立数据库服务、前后端分离的部署架构、微服务或生产环境双进程。开发环境允许 Vite 中间件/HMR，但生产环境必须由同一个 Fastify 进程提供前端静态页面、HTTP API 和 WebSocket。

```text
浏览器（Vue 3 / Vite 构建产物）
         │  同源 HTTP + WebSocket（同一端口）
         ▼
单个 Node.js / Fastify 进程
  ├─ 静态文件：dist/client（SPA 路由 fallback，不覆盖 /api、/ws）
  ├─ HTTP API：建房 / 加房 / 健康检查
  ├─ WebSocket：订阅 / 心跳 / 玩家动作 / 重连
  ├─ RoomManager：Map<roomId, RoomRuntime>，每房串行处理
  ├─ PokerEngine：纯 TypeScript 规则逻辑
  └─ SQLite：./data/poker.sqlite（自动创建，持久化快照和记录）
```

**工程结构**：不采用 `apps/web`、`apps/server` 两套应用。根目录只有一个 `package.json` 和锁文件；`src/client/` 放 Vue 页面、`src/server/` 放 Fastify 与 WebSocket、`src/shared/` 放协议与类型、`src/engine/` 放无框架依赖的牌局引擎。`vite.config.ts` 构建前端到 `dist/client/`；服务端 TypeScript 构建到 `dist/server/`。`npm run build` 构建两部分，`npm start` 仅运行 `node dist/server/index.js`。依赖版本和运行时 SQLite 驱动按当前 Node 支持情况选择并锁定，优先无需单独数据库进程的 SQLite 驱动。

**数据库零配置**：首次启动自动创建 `data/`（若不存在）、打开 `data/poker.sqlite`、启用 `PRAGMA foreign_keys=ON` 和 `journal_mode=WAL`、执行有版本号的幂等迁移、加载未关闭房间的快照，然后才开始监听端口。迁移失败必须终止启动并输出明确错误；数据库文件和 `-wal`/`-shm` 文件不可放进会被构建或部署清空的目录。`data/` 与 `.env` 加入 `.gitignore`，部署升级严禁删除数据目录；定期进行 SQLite 一致性备份并演练恢复。

**内存与持久化边界**：活跃房间、连接表、行动计时器与每房命令队列放内存；SQLite 保存房间设置、随机访客身份/重连凭证的安全摘要、手牌结算、关键事件和可恢复快照（包括牌堆位置、私有手牌、筹码、轮次、行动截止时间、版本号）。只向相应玩家发送本人私牌。影响筹码和牌局的命令先校验并在 SQLite 事务内写入事件/快照，再发布成功状态；结算与手牌记录保证幂等。服务器重启时恢复一致状态并根据持久化的截止时间确定超时动作；不能承诺连接本身跨重启保留，客户端须自动重连。

**单实例限制**：生产环境同一时刻只能有一个写入游戏状态的应用实例；PM2 如使用只能 `instances: 1`、fork 模式，禁止 cluster 和多副本部署。SQLite 不是跨服务器房间共享方案。首版不要求多服务器扩容，未来确需扩展再另立架构设计，不得擅自添加 Redis。

**启动与发布合同**：首次部署 `npm ci && npm run build && npm start`，以后更新代码 `npm ci && npm run build && npm start`（由进程管理器重启也可以）；用户访问 `http://服务器IP:端口` 即可打开网页，无须另起 Vite、前端容器或数据库。生产环境设置 `HOST=0.0.0.0`、`PORT=3000`、`DATABASE_PATH=./data/poker.sqlite`（可配置），若走 HTTPS 域名则可选择同机 Nginx 反代，但它不是运行前提。启动时记录迁移版本、监听地址和数据库路径，不泄露密钥。

## 6. 数据模型与协议合同

SQLite 至少包含 `schema_migrations`、`rooms`、`room_snapshots`、`hand_results` 和 `command_receipts`（用于幂等）；字段、索引、保留期限由 第 0 至第 4 阶段 细化。`room_snapshots` 中的敏感游戏内容只能由服务端读取，公共状态序列化必须剔除别人的底牌。SQLite 写入应有事务与 busy timeout，不能用“请求成功后异步落库”作为关键操作的一致性保证。


关键类型（示意，需由 Agent 细化为 zod schema 与 TypeScript 类型）：

```ts
type RoomStatus = 'waiting' | 'playing' | 'closed';
type Street = 'preflop' | 'flop' | 'turn' | 'river';
type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
interface PlayerPublic { playerId: string; seat: number; nickname: string;
  stack: number; committedStreet: number; committedHand: number;
  folded: boolean; allIn: boolean; connected: boolean; }
interface PublicGameState { roomId: string; handId: string; version: number;
  street: Street | 'showdown' | 'settlement'; actingPlayerId?: string;
  board: string[]; pot: number; players: PlayerPublic[]; turnDeadlineAt?: number; }
interface PrivateSelfState { playerId: string; holeCards: [string, string] | [];
  legalActions: LegalAction[]; reconnectToken?: string; }
interface ActionCommand { requestId: string; handId: string; expectedVersion: number;
  action: ActionType; amount?: number; }
```

**服务端 → 客户端**：`room.snapshot`、`room.player_joined`、`hand.started`、`hand.state_changed`、`turn.started`、`hand.settled`、`room.error`、`connection.recovered`。**客户端 → 服务端**：`room.join`、`seat.take`、`seat.leave`、`room.ready`、`game.action`、`heartbeat`。事件携带 `eventId`、`roomId`、`handId`、`version`、`serverTime`；涉及私人底牌时只定向发送。协议字段及错误码集中维护于 `packages/shared`。

每条动作命令校验房间身份、当前行动者、牌局 ID、合法动作、数值边界和状态版本；用 `requestId` 幂等去重。服务器串行处理一个房间的命令；客户端仅做乐观交互反馈，最终状态以服务器事件为准。收到版本缺口时重新请求快照；重连后恢复自己手牌及轮次，但永远不得展示别人未公开的底牌。所有日志避免记录底牌原文、会话凭证和敏感密钥。

## 7. 目录结构建议（一仓库 / 一 package.json）

```text
poker-room/
├─ package.json                 # 唯一项目包与统一 scripts
├─ package-lock.json            # 锁定依赖（使用 npm）
├─ vite.config.ts
├─ tsconfig.json
├─ src/
│  ├─ client/                   # Vue、PrimeVue、状态管理、牌桌 UI
│  ├─ server/                   # Fastify 入口、HTTP、WS、房间管理
│  │  ├─ index.ts               # 唯一生产启动入口
│  │  └─ db/                    # SQLite 初始化、迁移、事务与仓储
│  ├─ shared/                   # 协议 schema 和共享类型
│  └─ engine/                   # 纯 TS 德州扑克规则引擎
├─ migrations/                  # 有序、幂等、版本化 SQL 迁移
├─ data/                        # 运行时自动创建；持久数据，不能打包覆盖
├─ dist/client/                 # 构建输出：前端静态文件
├─ dist/server/                 # 构建输出：Node 服务端
├─ tests/
├─ docs/POKER_SPEC.md
└─ .dsh/skills/                 # Harness 项目级技能
```

推荐唯一脚本合同：`npm run dev`（本地开发入口）、`npm run build`（前后端一起构建）、`npm start`（一个生产进程）、`npm run lint`、`npm run typecheck`、`npm test`。开发模式的实现由 Agent 选定，但不得改变生产单进程约束。构建产物和 `data/` 严格分离，数据库不得由构建脚本重建或清空。

## 8. 四个 UI Skill：DeepSeek Harness 专用接入

DeepSeek Harness 的本地 Skill 目录支持 `<name>/SKILL.md` 及根目录扁平 `<name>.md`。官方文档明确扫描 `<project>/.dsh/skills`、`<project>/.agents/skills`、`~/.dsh/skills` 和 `~/.agents/skills`；项目级优先。安装完先检查目录、frontmatter 和 Harness 会话 Skill 列表，而不是只看 `npx` 退出码。[4]

| 技能名称 | 官方仓库 | 本项目何时使用 |
|---|---|---|
| UI UX Pro Max | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | 设计变量、版式、交互与响应式基线 |
| Frontend Design | https://github.com/anthropics/skills/tree/main/skills/frontend-design | 制作大厅、牌桌和完整页面 |
| Web Design Guidelines | https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines | 审查键盘访问、焦点、触控、性能和动效 |
| PixiJS Skills（技能集） | https://github.com/pixijs/pixijs-skills | **体验增强阶段可选**，复杂 2D 动画/场景，不是必选的第四个页面设计 Skill |

**macOS 项目级安装（推荐；执行前检查仓库内容与许可证）**：

```bash
# 在 poker-room 项目根目录执行；不要在生产服务器上盲目运行
mkdir -p .dsh/skills .agents/skills .skill-sources

# UI UX Pro Max：官方通用 Agent 安装入口会写入 .agents/skills/
npx ui-ux-pro-max-cli init --ai universal

# 以下三个仓库先拉到源码缓存，再按 DSH 要求复制 Skill 文件夹
git clone --depth 1 https://github.com/anthropics/skills.git .skill-sources/anthropics-skills
cp -R .skill-sources/anthropics-skills/skills/frontend-design .dsh/skills/

git clone --depth 1 https://github.com/vercel-labs/agent-skills.git .skill-sources/vercel-agent-skills
cp -R .skill-sources/vercel-agent-skills/skills/web-design-guidelines .dsh/skills/

# PixiJS 先安装路由及最有可能用到的几个子技能；P0 可以跳过
git clone --depth 1 https://github.com/pixijs/pixijs-skills.git .skill-sources/pixijs-skills
for name in pixijs pixijs-application pixijs-scene-graphics pixijs-scene-sprite pixijs-events pixijs-performance pixijs-ticker; do
  cp -R ".skill-sources/pixijs-skills/skills/$name" .dsh/skills/
done

# 检查（应能看到各目录中的 SKILL.md）
find .dsh/skills .agents/skills -name SKILL.md -print
```

以上命令是**适配 Harness 目录规范的项目级部署方法**，并非宣称 `skills` CLI 具有 DeepSeek Harness 专属 `-a` 目标参数。`.skill-sources/` 加到 `.gitignore`；复制前检查第三方仓库内附带脚本和许可，避免执行不可信安装脚本。若项目中已有对应克隆目录，先更新或跳过 clone，不要覆盖已修改文件。[4][5][6][7][8]

**Skill 调用顺序**：设计系统 → Frontend Design 生成页面 → Web Design Guidelines 审查并修复 → 如果确有性能/动画需求，再加载 PixiJS。Harness 里先让 AI 开发助手列出实际发现的 Skill；如果任何项未发现，排查目录和 YAML frontmatter，禁止假装已加载。

## 9. AGENTS.md（建议复制到项目根目录）

```md
# Poker Room — AI 开发助手工作约定
- 编写代码前先阅读 docs/POKER_SPEC.md，严格遵守首版开发范围和验收标准。
- 禁止实现真钱赌博、充值、提现或可兑换筹码。
- 每个阶段开始前：检查当前项目，列出实际发现的适用技能，并给出简短实施计划。
- 界面设计使用 UI UX Pro Max 与 Frontend Design；界面检查使用 Web Design Guidelines。
- 只有在确认 CSS/SVG 无法满足需求时才引入 PixiJS。
- 扑克规则必须放在 src/engine 中的纯 TypeScript 模块；牌堆、手牌与筹码均由服务端统一裁定。
- 只保留一个 package.json、一个 Fastify 生产进程、一个端口和一次部署；由 Fastify 提供构建后的 Vue 页面。
- 启动时自动创建 SQLite 文件并执行数据库迁移；活跃房间使用进程内 Map。严禁引入 Redis、MySQL、独立前端部署或第二个生产服务。
- 禁止向客户端发送其他玩家尚未公开的底牌。
- 只修改当前项目必要文件，不得改动无关项目或部署配置。
- 执行代码规范检查、类型检查及相关测试，并报告实际结果，不得假定测试通过。
- 每完成一个阶段，用简体中文列出修改的文件、执行的命令、验收结果和下一步建议。
- 未经批准不得安装依赖、执行破坏性命令或访问密钥。
```

## 10. 核心组件与可交付 UI

`PokerTable.vue` 负责桌面背景与布局；`PlayerSeat.vue` 负责玩家信息、庄位、下注额、倒计时和状态；`PlayingCard.vue` 支持正面/背面/花色；`CommunityCards.vue` 负责 0/3/4/5 张公共牌；`ActionBar.vue` 根据 `legalActions` 展示正确按钮与金额控件；`ConnectionBanner.vue` 显示断线、重试、同步中；`HandResultOverlay.vue` 展示赢家、牌型、各边池分配。

前端状态层分为 `roomStore`（房间和玩家）、`gameStore`（服务端快照）、`connectionStore`（链路/时钟偏移）；不要同时维护多个冲突的“筹码真相”。每个组件有 加载中、空状态、出错、禁用和键盘焦点状态。桌面动效预算以基础 60fps 为目标，但以实际设备分析结果为准，不能编造性能结果。

## 11. 安全、可靠性与合规边界

- 私有房间随机不可枚举 ID；邀请凭证与玩家重连凭证分开；仅服务端校验权限。防止猜房和冒名回桌。
- 服务端使用加密安全随机数洗牌，并记录可审计的发牌流程；禁止客户端指定牌序、输赢或筹码余额。
- 输入 schema 校验、单 IP / 单房间限流、WebSocket 心跳与消息大小限制；文本聊天做内容长度限制和安全转义。
- 保护个人信息：访客模式不要求手机号；尽量不记录 IP 与聊天内容；日志脱敏；提供删除房间记录的策略。
- 游戏状态重启恢复、命令幂等和单房间串行执行必须经过故障演练；不能只依赖客户端随机延时。
- 默认筹码没有法币价值，禁止充值、提现、转让兑换或引导第三方交易；如未来改变经营方式，先取得目标司法辖区的专业法律意见并重新制定需求，不把本规格书视为合规批准。
- Harness 本身仍属开发者预览、未经过安全审计；用本机独立工作区或容器最小权限运行，备份仓库，审批脚本与插件。**不允许它接触支付业务生产密钥和数据库。**[3]

## 12. 测试矩阵和完成门槛

| 测试类别 | 最少覆盖项 | 通过条件 |
|---|---|---|
| 单元测试：规则 | A2345 顺子、同花顺、高牌 踢脚牌、同牌平分、双人桌、盲位、最小加注、未满额 All-in、边池 | 每个输入都有确定预期，不靠视觉判断 |
| 属性测试／不变量检查 | 52 张不重复、筹码守恒、底池非负、每人最多两张底牌、唯一行动者 | 多随机种子测试，无反例 |
| 集成测试 | 2/6/9 人、合法/非法动作、重复请求、过期版本、倒计时 | 状态版本严格递增、非法命令不改变状态 |
| 端到端测试 | 两个浏览器创建/加入、完整打完一局、退出回桌 | 实际浏览器完成闭环，无需手动修改数据库 |
| 信息安全 | 玩家 A 无法从网络消息中获取玩家 B 未公开的底牌；旁观者无法获取任何私人手牌 | 各阶段核查客户端接收的数据 |
| 网络故障 | WebSocket 中断、重新连接、刷新、服务器重启（SQLite 快照恢复） | 恢复一致快照，不重复结算 |
| 界面适配 | 1280×720、1440×900、844×390、390×844 | 无重要内容遮挡、无横向溢出、关键操作可点 |
| 无障碍体验 | 键盘聚焦、按钮标签、非颜色提示、减少动画 | 审查发现的问题已记录并修复 |

每阶段跑 `lint`、`typecheck` 和相关测试；没有脚本时先补充脚本。不要用“看起来可以”代替证据。最终提供测试命令、真实终端结果、已知问题和复现步骤。

## 13. Harness 分阶段实施计划（每阶段独立验收）

### 第 0 阶段｜工程初始化
创建单仓库、唯一 `package.json`、Vite/Vue/Fastify、`src/shared`、`src/engine`、SQLite 自动初始化/版本化迁移、基础脚本、`.env.example`、`.gitignore`、README。确保 `npm ci`、`npm run build`、`npm start` 可运行；访问同一端口可打开网页与 `/api/health`，首次启动自动生成 `data/poker.sqlite`，重启数据保留。先确认 Node 版本和 SQLite 驱动兼容性，不修改其他项目。

### 第 1 阶段｜高保真界面与模拟数据原型
先制定界面设计规范、页面草图与组件对应关系，再实现首页、房间等待页和 6 人桌；使用模拟数据切换翻牌前、翻牌、转牌、河牌、摊牌、自己的回合、All-in、断线和结算。完成响应式与截图自检。**验收：无服务器也能流畅演示核心牌桌 UI。**

### 第 2 阶段｜纯规则引擎
实现牌堆、座位/盲注、下注与重新行动、牌型比较、边池、结算和完整状态机；建立确定性种子/依赖注入方便测试，生产改用安全随机源。**验收：多组规则单测与筹码守恒测试通过。**

### 第 3 阶段｜联机闭环
实现建房、入座、邀请、WebSocket 事件/动作、服务端权威状态、私有数据过滤；两个真实浏览器打完一手并进入下一手。**验收：不允许作弊请求或看到他人手牌。**

### 第 4 阶段｜重连、可靠性与基础持久化
实现 SQLite 事务化版本快照与关键事件、幂等、重连凭证、服务端计时器、日志脱敏和重启恢复测试。**验收：断线/刷新/单进程重启后能够恢复一致牌局，重复结算为 0，SQLite 数据文件保留。**

### 第 5 阶段｜UI 质量与发布候选
用 Web Design Guidelines 审核可用性/键盘/动效/性能；修复手机布局；可选 PixiJS 动效；补充 Playwright 端到端自动化测试、SQLite 备份恢复演练、单进程发布说明及部署检查。**验收：单次部署后一个端口同时提供网页、接口和 WebSocket，无 Redis/MySQL 等外部依赖；全套测试及验收报告通过。**

## 14. 每阶段 Harness 输出格式与停止条件

每个阶段按固定结构用简体中文汇报：**①本阶段目标 ②已加载 Skills（实际名称）③实施方案 ④修改文件 ⑤运行命令与真实结果 ⑥验收清单 ⑦已知风险 ⑧下一阶段建议**。遇到缺失权限、未知协议、安装失败或无法复现时必须给出明确阻塞；禁止虚报“测试通过”。完成当前阶段后先停止，等用户明确要求下一阶段才继续。

**变更边界**：禁止引入真钱逻辑；禁止修改与本游戏无关的 EzCash/支付项目或全局配置；禁止自动使用生产服务器 SSH/数据库凭据；禁止绕开校验用前端模拟结果充当真实后端成功。

## 15. 复制给 DeepSeek Harness 的启动总指令

```text
你是这个项目的 技术负责人、资深 Vue 游戏界面设计师和 TypeScript 后端工程师。
请首先完整阅读 docs/POKER_SPEC.md，并把它视为产品需求和验收标准。
所有需求解释、实施计划、阶段汇报和验收报告一律使用简体中文；技术名词、文件名和代码标识符保持原样。
当前只执行 第 0 阶段（工程初始化），不要跳到联机、规则或动画阶段。

执行顺序：
1. 检查仓库现状、Node / npm 环境与现有文件，不覆盖已有工作。
2. 列出 Harness 实际发现的 Skills；如果 UI UX Pro Max / Frontend Design /
   Web Design Guidelines 未被发现，明确报告目录问题，不要声称已加载。
3. 给出最多 8 步的短计划，再按计划完成 第 0 阶段。
4. 使用 Vue 3 + TypeScript + Vite + PrimeVue、Fastify + TypeScript，
   仅有一个 package.json；src/engine 为纯 TypeScript 模块，src/shared 集中协议 schema。
   Fastify 生产环境同时提供前端静态页、HTTP API 与 WebSocket，单端口单进程。
   采用 SQLite 文件库，服务启动自动创建并迁移；房间实时状态采用内存 Map。
   绝不引入 Redis、MySQL、独立前端进程、独立数据库服务或微服务。
5. 仅使用虚拟不可兑换筹码；绝不加入真钱、充值、提现或支付能力。
6. 对依赖安装、删除文件、执行未知脚本先展示命令及目的，遵守审批。
7. 运行真实的 lint / typecheck / 测试 / 启动检查，验证首次启动建库、第二次启动保留数据以及同端口网页/API；无法运行则说明原因。
8. 最后按规格书第 14 节汇报，完成 第 0 阶段 后停止。
```

后续阶段单独发送：`阅读 docs/POKER_SPEC.md。现在只执行 第 N 阶段，使用对应 Skills，满足本阶段全部验收要求；完成后按第 14 节汇报并停止。` 请将 `N` 替换为实际阶段编号。

## 16. 官方资料与版本提醒

[1] DeepSeek Harness 官方站点及启动方式：https://deepseek.com/harness/en/

[2] DeepSeek Harness 官方快速入门：https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart

[3] DeepSeek Harness 安全说明：https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md

[4] DeepSeek Harness 本地 Skill 发现规则：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md

[5] UI UX Pro Max 安装说明：https://github.com/nextlevelbuilder/ui-ux-pro-max-skill

[6] Anthropic Frontend Design：https://github.com/anthropics/skills/tree/main/skills/frontend-design

[7] Vercel Web Design Guidelines：https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines

[8] PixiJS 官方 Skills：https://github.com/pixijs/pixijs-skills

[9] DeepSeek Harness 模型设置：https://deepseek-harness.github.io/deepseek-harness/en/guide/providers

资料核对日期：2026-09-21。Harness 及第三方 Skill 都可能更新；执行安装前以仓库当前 README 为准。以上是软件开发规划，不是赌博业务或法律合规意见。
