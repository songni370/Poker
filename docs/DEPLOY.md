# 部署与发布检查（单进程 / 单端口）

> 本项目的硬约束：**一个仓库、一个 `package.json`、一个 Node 进程、一个端口、一次部署**。
> 不引入 Redis / MySQL / PostgreSQL / 独立前端部署 / 微服务 / 生产双进程。

## 1. 首次部署

```bash
git clone <repo> && cd poker-room
npm ci
npm run build          # 前端 → dist/client，服务端 → dist/server
HOST=0.0.0.0 PORT=3000 DATABASE_PATH=./data/poker.sqlite npm start
```

访问 `http://<服务器IP>:3000` 即可：**同一个端口同时提供网页、HTTP API 与 WebSocket**，无需另起 Vite、前端容器或数据库服务。

## 2. 后续升级

```bash
npm ci && npm run build && npm start     # 或交给进程管理器重启
```

**升级严禁删除 `data/` 目录**（构建产物在 `dist/`，运行期数据在 `data/`，两者严格分离）。

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 生产建议 `0.0.0.0` |
| `PORT` | `3000` | 唯一监听端口 |
| `DATABASE_PATH` | `./data/poker.sqlite` | 目录不存在会自动创建；升级不要动它 |
| `CLIENT_DIR` | `./dist/client` | 构建后的前端静态目录 |
| `LOG_LEVEL` | `info` | 日志级别；启动日志会记录迁移版本、监听地址、数据库路径（不含密钥） |

参考 `.env.example`。**不要**把 API Key、支付密钥等放进本项目。

## 4. 发布前自检

```bash
npm run lint && npm run typecheck && npm test    # 静态检查与单元/集成测试
npm run e2e                                       # Playwright：真实浏览器双会话跑完一手
npm run check:deploy                              # 对已启动的服务做单端口部署自检
npm run backup                                    # SQLite 备份 / 恢复演练（独立库，不动生产数据）
```

`npm run check:deploy` 会在目标机上检查：健康接口、同端口网页、SPA 深链回落与 `/api` 边界、同端口 WebSocket 握手、以及**不存在 Redis/MySQL/PostgreSQL 等外部服务配置**。

`npm run e2e` 需要 Google Chrome（使用系统已装浏览器，不额外下载内核）；它会用**独立端口 + 独立数据库**启动一次生产进程，因此可以随时运行、不干扰正在服务的实例。

## 5. 单实例约束

- 同一时刻只允许一个写入游戏状态的进程。
- PM2 只能用 `instances: 1` + **fork** 模式；禁止 cluster 与多副本。
- SQLite 不是跨服务器共享方案；首版不做多机扩容（确需扩容要另立架构设计，且不得擅自引入 Redis）。

## 6. 数据与备份

```bash
sqlite3 data/poker.sqlite "VACUUM INTO 'data/backups/poker-$(date +%F-%H%M).sqlite'"
```

- 推荐方式：`VACUUM INTO`（WAL 下安全，不需要停服）；`npm run backup` 就是按这个流程做的完整演练（备份 → 校验完整性 → 删除原库 → 恢复 → 重启服务验证房间仍可访问）。
- 备份文件要定期复制到**异机**；`data/` 与 `data/backups/` 都不要放进构建或部署会清空的目录。
- 恢复：停服 → 用备份覆盖 `data/poker.sqlite`（同时删除 `-wal` / `-shm`）→ 启动。启动时会从 `room_snapshots` 恢复未关闭的房间。

## 7. 反向代理（可选）

走 HTTPS 域名时可以在同机加 Nginx 反代，但**它不是运行前提**。注意必须同时转发 WebSocket 升级头：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 8. 已知运维注意点

- **PrimeVue 许可**：依赖锁定在 MIT 版本（`primevue@4.5.5` / `@primeuix/themes@2.0.3` / `primeicons@7.0.0`）。升级到 5.x 前必须先确认 PrimeTek 商业许可，否则界面右下角会出现 “Invalid PrimeUI License” 水印。
- **npm 缓存**：仓库内 `.npmrc` 设了 `cache=./.npm-cache`（为受限沙箱准备）。普通服务器可删除该文件，恢复到默认缓存位置。
- **单进程重启**：连接本身不跨重启保留，客户端会自动重连并收到 `connection.recovered` 快照；牌局从 SQLite 快照恢复。
- **合规**：虚拟筹码不可充值、不可提现、不可转让兑换；本项目不提供任何真钱赌博功能。
