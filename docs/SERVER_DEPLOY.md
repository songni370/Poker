# Poker Room 部署到 18.138.227.214

按现有服务器环境执行：Debian 13，已安装 Nginx、SQLite、nvm、Node 24 和 npm。**应用使用一个固定目录 `/var/www/poker-room`，由 PM2 管理一个进程。**以下命令由你在终端执行。

## 1. 服务器准备（首次一次）

本地运行 `ssh 18.138.227.214` 登录服务器。确认 Node 可用；若 PM2、rsync、sqlite3、curl 或 flock 尚未安装，再安装它们（apt 和 Nginx 配置需要 root 或 sudo 权限）：

```bash
node -v
npm -v
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
command -v rsync
command -v sqlite3
command -v curl
command -v flock
# 如缺少上述工具：sudo apt install -y rsync sqlite3 curl util-linux
mkdir -p /var/www/poker-room/data/backups
```

请以 `node -v` 的结果确认 Node ≥ 24。非交互 SSH 不保证自动加载 nvm；部署脚本会显式加载 `${NVM_DIR:-$HOME/.nvm}/nvm.sh`。Poker Room 不需要 `.env.production`：程序从环境变量读取配置，SQLite 默认使用项目目录中的 `data/poker.sqlite`，首次启动自动建库并迁移。

## 2. 本地一键发布（首次和后续更新通用）

在本地执行：

```bash
cd /Users/wuyi/MyProjects/Poker
./deploy.sh
# 如 SSH 未配置默认用户，可显式指定：
# ./deploy.sh root@18.138.227.214
```

本地需要 Node ≥ 24、已安装的项目依赖、SSH 和 rsync；脚本不会自动安装本地依赖或服务器工具。SSH 使用你现有的用户、配置和认证方式，不关闭主机指纹校验。该用户必须能写入 `/var/www/poker-room`，并且必须与现有 PM2 应用的启动用户一致。

脚本执行顺序：

1. 执行 `npm run lint`、`npm run typecheck` 和 `npm run build`，任何一步失败即退出。
2. 通过非交互 SSH 显式加载 nvm，检查远端工具；上传到唯一暂存目录，在其中执行 `npm ci --omit=dev`。此时旧服务继续运行。
3. 取得发布锁，验证已有 PM2 应用使用固定路径、单 fork 实例、关闭 watch 和默认数据库；停服后备份 SQLite 并检查备份完整性。
4. 更新构建产物、迁移、清单和依赖，首次启动或更新 PM2 环境变量后重启。`--delete` 只作用于 `dist/`，不会删除 `data/`。
5. 等待健康接口就绪，再运行 `npm run check:deploy` 验证网页、API 和 WebSocket，成功后 `pm2 save` 并清理本次暂存目录。

发布会短暂停服，在线连接会断开并重连。备份位于 `data/backups/`。如果停服后的步骤失败，可能保持停服或留下部分更新；脚本会报错并保留暂存目录，不自动回滚。修复错误后重新执行脚本。数据库迁移后的回滚必须先检查兼容性。失败暂存目录和历史备份需人工定期清理；不要同时手动发布和运行脚本。

脚本按本文的固定配置部署：应用目录 `/var/www/poker-room`、进程名 `poker-room`、监听 `127.0.0.1:3000`、数据库 `data/poker.sqlite`。它不会配置 Nginx、系统开机自启或云安全组，首次部署需完成后续两节。

## 3. 首次配置开机启动

使用与部署相同的 SSH 用户登录，运行 `pm2 startup`，按输出执行开机启动命令，再运行 `pm2 save`。nvm 升级 Node 后，应按 [PM2 官方说明](https://pm2.keymetrics.io/docs/usage/startup/)更新开机启动配置。

日志用 `pm2 logs poker-room --lines 100 --nostream` 查看。更改环境变量需使用 `--update-env`，参见 [PM2 进程管理文档](https://pm2.keymetrics.io/docs/usage/process-management/)。非交互 shell 的 nvm 加载方式参见 [nvm 官方说明](https://github.com/nvm-sh/nvm#installing-and-updating)。

## 4. 配置 Nginx（首次一次）

仍在服务器执行。Nginx 已安装并运行；新增一个以服务器 IP 为名称的站点，将网页、API 和 WebSocket 全部转发到 Fastify 的同一个端口。WebSocket 需要转发升级头，参见 [Nginx 官方文档](https://nginx.org/en/docs/http/websocket.html)。

```bash
cat > /etc/nginx/sites-available/poker-room <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name 18.138.227.214;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
EOF
test -L /etc/nginx/sites-enabled/poker-room || ln -s /etc/nginx/sites-available/poker-room /etc/nginx/sites-enabled/poker-room
nginx -t
systemctl reload nginx
curl -I http://127.0.0.1/ -H 'Host: 18.138.227.214'
```

在云安全组开放 TCP 80，浏览器访问 `http://18.138.227.214/`。3000 只监听本机，无需对外开放。当前只配置 HTTP；以后有域名和证书，再给 Nginx 配置 HTTPS/443。

## 5. 文档复核结果

原方案的单进程、单端口、Fastify 托管页面、SQLite 迁移和 Nginx WebSocket 代理方向正确。本次修正了以下发布细节：

- 原先直接覆盖运行中的 `dist/`，可能出现页面与服务端版本不一致；安装依赖失败也会留下部分更新。现在先暂存并安装成功，再停服替换。
- 原先备份时仍可能有玩家写入。现在先停服再备份，且首次无数据库时跳过备份。
- 自动化 SSH 不保证加载 nvm；脚本显式加载并检查 Node 版本。
- 原先重启后立即 curl 可能误判失败；现在等待服务就绪并执行已有部署自检。
- 新增明确的 SSH 用户、目录权限、发布失败处理和 PM2 环境更新说明。

本次仅核对仓库代码和工具官方文档，没有登录服务器验证本文描述的已安装工具和线上状态。
