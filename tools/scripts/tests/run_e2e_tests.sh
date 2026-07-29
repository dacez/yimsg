#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
trap test_cleanup_owned_server EXIT

cd "${TEST_ROOT_DIR}"
test_ensure_node_modules
test_ensure_go_modules
test_ensure_playwright_browser
test_ensure_server

host="${YIMSG_TEST_SERVER_HOST}"
port="${YIMSG_TEST_SERVER_PORT}"
config="${YIMSG_TEST_CONFIG}"

test_run_step "Server E2E" \
  go test -count=1 -v -timeout=3m ./server/tests/e2e/... \
  -tls=false -host="${host}" -port="${port}" -config="${config}"
test_run_step "CLI E2E" \
  go test -count=1 -v -timeout=3m ./cli/tests/e2e/... \
  -tls=false -host="${host}" -port="${port}"
test_run_step "Agent E2E" \
  go test -count=1 -v -timeout=3m ./agent/tests/e2e/... \
  -tls=false -host="${host}" -port="${port}"
test_run_step "Web Chromium E2E" \
  npm run test:e2e
