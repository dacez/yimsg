#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
trap test_cleanup_owned_server EXIT

cd "${TEST_ROOT_DIR}"
test_ensure_node_modules
if [[ -z "${SERVER_WS_URL:-}" ]]; then
  test_ensure_server
  export SERVER_WS_URL="ws://${YIMSG_TEST_SERVER_HOST}:${YIMSG_TEST_SERVER_PORT}/ws"
fi

test_run_step "SDK 真实服务端集成测试" npm run test:sdk
