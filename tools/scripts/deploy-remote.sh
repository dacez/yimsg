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
# 同一台服务器可能同时被 GitHub Actions 和本脚本触发；上传阶段用带这个 tag 的独立
# 文件名/目录名，避免两边并发写同一个上传目标把内容写坏（历史教训：曾经两边同时
# scp 到同一个 server.new，写出的文件大小相同但内容不同，服务器起不来）。
RUN_TAG="local-$$"

echo "==== [${alias_name}] 刷新协议生成物 ===="
go run ./tools/cmd/protocolgen

echo "==== [${alias_name}] 构建前端产物 ===="
npm run build

echo "==== [${alias_name}] 交叉编译服务端二进制（Linux/amd64）===="
GOOS=linux GOARCH=amd64 go build -o server-linux-amd64 ./server/cmd/yimsg-server

echo "==== [${alias_name}] 交叉编译 seed-demo 二进制（Linux/amd64）===="
GOOS=linux GOARCH=amd64 go build -o seed-demo-linux-amd64 ./server/tools/cmd/seed-demo

echo "==== [${alias_name}] 上传二进制与前端 / 官网产物 ===="
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp server-linux-amd64 "${alias_name}:/opt/yimsg/server.new.${RUN_TAG}"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp seed-demo-linux-amd64 "${alias_name}:/opt/yimsg/seed-demo.new.${RUN_TAG}"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp -r web/. "${alias_name}:/opt/yimsg/web.new.${RUN_TAG}/"
timeout --foreground "${SCP_TIMEOUT_SECONDS}s" scp -r website/. "${alias_name}:/opt/yimsg/website.new.${RUN_TAG}/"

echo "==== [${alias_name}] 远程原子替换二进制、清空数据并用新构建的 seed-demo 重新初始化，最后重启服务 ===="
timeout --foreground 1800s ssh "${alias_name}" "
  set -euo pipefail
  # 上一步上传阶段已经用 RUN_TAG 隔开了各自的上传目标，这里只需要给最终原子替换这段
  # 临界区加文件锁（跟 .github/workflows/deploy.yml 共用同一把）：避免两边同时
  # stop/replace/seed-demo 互相踩踏；谁先抢到锁谁先跑完，后到的一方等前面跑完后
  # 照常执行（即后完成的部署最终生效）。
  exec 200>/opt/yimsg/.deploy.lock
  flock -w 1800 200

  systemctl stop yimsg

  chmod +x /opt/yimsg/server.new.${RUN_TAG}
  mv /opt/yimsg/server.new.${RUN_TAG} /opt/yimsg/server

  chmod +x /opt/yimsg/seed-demo.new.${RUN_TAG}
  mv /opt/yimsg/seed-demo.new.${RUN_TAG} /opt/yimsg/seed-demo

  rm -rf /opt/yimsg/web
  mv /opt/yimsg/web.new.${RUN_TAG} /opt/yimsg/web
  rm -rf /opt/yimsg/website
  mv /opt/yimsg/website.new.${RUN_TAG} /opt/yimsg/website

  chown -R yimsg:yimsg /opt/yimsg
  setcap -r /opt/yimsg/server 2>/dev/null || true

  /opt/yimsg/seed-demo -config /opt/yimsg/config.toml
  chown -R yimsg:yimsg /opt/yimsg/data

  systemctl start yimsg
"

echo "==== [${alias_name}] 验证部署结果 ===="
ssh "${alias_name}" "systemctl status yimsg --no-pager"
HOST="$(ssh -G "${alias_name}" | awk '$1=="hostname"{print $2}')"
curl -k -sS --connect-timeout 20 --max-time 60 -o /dev/null -w "[${alias_name}] 官网 /: %{http_code}\n" "https://${HOST}/"
curl -k -sS --connect-timeout 20 --max-time 60 -o /dev/null -w "[${alias_name}] 聊天 /app/: %{http_code}\n" "https://${HOST}/app/"

echo "部署完成：${alias_name}"
