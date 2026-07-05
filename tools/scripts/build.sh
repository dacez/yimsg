#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/frontend"
SERVER_BIN="${ROOT_DIR}/server"
WEB_DIR="${ROOT_DIR}/web"

cd "${ROOT_DIR}"

echo "==== 清理旧产物 ===="
rm -rf "${WEB_DIR}"
rm -f "${SERVER_BIN}"

echo "==== 刷新协议生成物 ===="
go run ./tools/cmd/protocolgen

echo "==== 重新生成前端网页 ===="
(cd "${FRONTEND_DIR}" && npm run build)

echo "==== 重新生成 server 二进制 ===="
go build -o "${SERVER_BIN}" ./cmd/server

echo "构建完成：${WEB_DIR}，${SERVER_BIN}"
