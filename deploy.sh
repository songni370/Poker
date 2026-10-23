#!/usr/bin/env bash
# 本地执行：./deploy.sh [user@host 或 SSH 别名]
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
DEPLOY_HOST=${1:-18.138.227.214}
if [[ $# -gt 1 || ! "$DEPLOY_HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]]; then
  echo '用法：./deploy.sh [user@host 或 SSH 别名]' >&2
  exit 2
fi
for tool in node npm ssh rsync; do
  command -v "$tool" >/dev/null || { echo "本地缺少 $tool" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
trap 'echo "部署失败（第 $LINENO 行）。请查看上方错误；未自动回滚。" >&2' ERR

echo '1/4 本地检查与构建'
npm run lint
npm run typecheck
npm run build

echo '2/4 检查服务器并创建暂存目录'
STAGE=$(ssh "$DEPLOY_HOST" 'bash -se' <<'REMOTE'
set -eo pipefail
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
for tool in node npm pm2 rsync sqlite3 curl flock; do
  command -v "$tool" >/dev/null || { echo "服务器缺少 $tool，请按部署文档准备" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
mkdir -p /var/www/poker-room/data/backups
mktemp -d /var/www/poker-room/.deploy-XXXXXXXX
REMOTE
)
[[ "$STAGE" =~ ^/var/www/poker-room/\.deploy-[a-zA-Z0-9]+$ ]]
rsync -az dist migrations package.json package-lock.json "$DEPLOY_HOST:$STAGE/"
rsync -az scripts/deploy-check.mjs "$DEPLOY_HOST:$STAGE/"

echo '3/4 安装生产依赖、备份并更新'
ssh "$DEPLOY_HOST" "bash -se -- '$STAGE'" <<'REMOTE'
set -Ee -o pipefail
STAGE=$1
APP=/var/www/poker-room
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
exec 9>"$APP/.deploy.lock"
flock -n 9 || { echo '另一项部署正在执行，请稍后重试' >&2; exit 1; }
trap 'echo "远程发布失败；暂存目录保留在 $STAGE。若已停服，请修复后重新部署。" >&2' ERR
cd "$STAGE"
npm ci --omit=dev
cd "$APP"
# 只读取此应用的运行参数，不输出 PM2 中其他应用的环境变量。
pm2 jlist | node --input-type=module -e '
let input = "";
for await (const chunk of process.stdin) input += chunk;
const apps = JSON.parse(input).filter(p => p.name === "poker-room");
if (apps.length > 1) throw Error("poker-room 必须只有一个实例");
if (apps.length) {
  const p = apps[0].pm2_env;
  if (p.exec_mode !== "fork_mode" || p.watch || p.pm_cwd !== process.cwd() ||
      p.pm_exec_path !== process.cwd() + "/dist/server/index.js" ||
      (p.DATABASE_PATH && !["./data/poker.sqlite", process.cwd() + "/data/poker.sqlite"].includes(p.DATABASE_PATH))) {
    throw Error("已有 PM2 配置与固定目录、单实例或默认数据库不符，请先人工核对");
  }
}'
EXISTING=false
if pm2 describe poker-room >/dev/null 2>&1; then
  EXISTING=true
  pm2 stop poker-room
fi
# 停服后备份，包含最后一次写入；首次启动没有数据库时跳过。
if [ -f data/poker.sqlite ]; then
  BACKUP="data/backups/poker-$(date -u +%Y%m%dT%H%M%SZ)-${STAGE##*/}.sqlite"
  sqlite3 data/poker.sqlite ".backup '$BACKUP'"
  [ "$(sqlite3 "$BACKUP" 'PRAGMA integrity_check;')" = ok ]
  echo "数据库已备份：$APP/$BACKUP"
fi
# --delete 仅限构建目录，绝不对应用根目录或 data 使用。
rsync -a --delete "$STAGE/dist/" "$APP/dist/"
rsync -a "$STAGE/migrations/" "$APP/migrations/"
cp "$STAGE/package.json" "$STAGE/package-lock.json" "$APP/"
# 旧依赖留在暂存目录，避免移动新依赖时覆盖非空目录。
if [ -d node_modules ]; then mv node_modules "$STAGE/previous-node_modules"; fi
mv "$STAGE/node_modules" "$APP/node_modules"
mkdir -p scripts
cp "$STAGE/deploy-check.mjs" scripts/deploy-check.mjs
export NODE_ENV=production HOST=127.0.0.1 PORT=3000
export DATABASE_PATH="$APP/data/poker.sqlite" CLIENT_DIR="$APP/dist/client"
if "$EXISTING"; then
  pm2 restart poker-room --update-env --interpreter "$(command -v node)"
else
  pm2 start dist/server/index.js --name poker-room --cwd "$APP" --interpreter "$(command -v node)" --kill-timeout 10000
fi
READY=false
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then
    READY=true
    break
  fi
  sleep 1
done
if ! "$READY"; then
  pm2 logs poker-room --lines 60 --nostream
  echo '服务未就绪，请检查日志。数据库备份与暂存目录均已保留。' >&2
  exit 1
fi
npm run check:deploy
pm2 save
# 只清理本次生成的暂存目录。
rm -rf -- "$STAGE"
echo '应用已启动并通过部署自检。'
REMOTE

echo "4/4 部署完成。已配置 Nginx 时可访问 http://18.138.227.214/"
