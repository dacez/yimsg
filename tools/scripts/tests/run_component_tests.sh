#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

cd "${TEST_ROOT_DIR}"
test_ensure_node_modules
test_ensure_playwright_browser
test_run_step "BoundedList Chromium 组件测试" \
  npm run test:component
