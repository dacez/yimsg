#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tools/scripts/deploy-remote.sh <ssh-alias>

Examples:
  tools/scripts/deploy-remote.sh yimsg-gz

本机快速部署：交叉编译 + 本机上传，跳过 GitHub Actions 的排队等待，适合上传带宽
较好、想更快看到效果的场景（如广州服务器）。跟 .github/workflows/deploy.yml 的
后半段（远程原子替换、清空 data 并用 seed-demo 重建、重启 systemd）完全一致，
两边通过服务器上的 /opt/yimsg/.deploy.lock 文件锁互斥：可以和 GitHub Actions 部署
同时对同一台机器触发，谁先抢到锁谁先跑，后完成的一方最终生效，不会互相踩踏。

目标机器必须已按 tools/scripts/init_server_env.sh 完成标准化环境初始化，且本机
~/.ssh/config 里已配置好对应别名（host/user/port/私钥）。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

alias_name="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

SCP_TIMEOUT_SECONDS="${DEPLOY_SCP_TIMEOUT_SECONDS:-1800}"

echo "==== [${alias_name}] 刷新协议生成物 ===="
go run ./tools/cmd/protocolgen

echo "==== [${alias_name}] 构建前端产物 ===="
npm run build

echo "==== [${alias_name}] 交叉编译服务端二进制（Linux/amd64）===="
GOOS=linux GOARCH=amd64 go build -o server-linux-amd64 ./server/cmd/yimsg-server

echo "==== [${alias_name}] 交叉编译 seed-demo 二进制（Linux/amd64）===="
GOOS=linux GOARCH=amd64 go build -o seed-demo-linux-amd64 ./server/tools/cmd/seed-demo

echo "==== [${alias_name}] 上传二进制与前端 / 官网产物 ===="
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp server-linux-amd64 "${alias_name}:/opt/yimsg/server.new"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp seed-demo-linux-amd64 "${alias_name}:/opt/yimsg/seed-demo.new"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp -r web/. "${alias_name}:/opt/yimsg/web/"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp -r website/. "${alias_name}:/opt/yimsg/website/"

echo "==== [${alias_name}] 远程原子替换二进制、清空数据并用新构建的 seed-demo 重新初始化，最后重启服务 ===="
timeout --foreground 1800s ssh "${alias_name}" '
  set -euo pipefail
  # 跟 .github/workflows/deploy.yml 共用同一把锁，避免和 CI 部署同时跑互相踩踏；
  # 谁先抢到锁谁先跑完，后到的一方等前面跑完后照常执行（即后完成的部署最终生效）。
  exec 200>/opt/yimsg/.deploy.lock
  flock -w 1800 200

  systemctl stop yimsg

  chmod +x /opt/yimsg/server.new
  mv /opt/yimsg/server.new /opt/yimsg/server

  chmod +x /opt/yimsg/seed-demo.new
  mv /opt/yimsg/seed-demo.new /opt/yimsg/seed-demo

  chown -R yimsg:yimsg /opt/yimsg
  setcap -r /opt/yimsg/server 2>/dev/null || true

  /opt/yimsg/seed-demo -config /opt/yimsg/config.toml
  chown -R yimsg:yimsg /opt/yimsg/data

  systemctl start yimsg
'

echo "==== [${alias_name}] 验证部署结果 ===="
ssh "${alias_name}" "systemctl status yimsg --no-pager"
HOST="$(ssh -G "${alias_name}" | awk '$1=="hostname"{print $2}')"
curl -k -sS --connect-timeout 20 --max-time 60 -o /dev/null -w "[${alias_name}] 官网 /: %{http_code}\n" "https://${HOST}/"
curl -k -sS --connect-timeout 20 --max-time 60 -o /dev/null -w "[${alias_name}] 聊天 /app/: %{http_code}\n" "https://${HOST}/app/"

echo "部署完成：${alias_name}"
