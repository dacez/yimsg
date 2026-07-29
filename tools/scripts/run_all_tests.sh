#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/tests/common.sh"
trap test_cleanup_owned_server EXIT

cd "${ROOT_DIR}"

# 依赖与生成物只准备一次，分类脚本通过显式环境标记复用。
test_ensure_node_modules
test_ensure_playwright_browser
test_ensure_go_codegen_deps
test_ensure_go_modules
export YIMSG_TEST_NODE_DEPS_READY=1
export YIMSG_TEST_PLAYWRIGHT_READY=1
export YIMSG_TEST_GO_DEPS_READY=1

test_run_step "Protocol codegen" go run ./tools/cmd/protocolgen
test_run_step "文档一致性" bash "${ROOT_DIR}/tools/check_docs_consistency.sh"

# 正确性门禁严格按测试层级执行；每一类也可以通过 tools/run_*_tests.sh 单独运行。
test_run_step "单元测试分类" bash "${ROOT_DIR}/tools/run_unit_tests.sh"

test_run_step "前端构建" npm run build
export YIMSG_SKIP_FRONTEND_BUILD=1
export YIMSG_TEST_SERVER_HOST="127.0.0.1"
export YIMSG_TEST_SERVER_PORT="38081"
test_kill_port_users "${YIMSG_TEST_SERVER_PORT}"
test_ensure_server

test_run_step "集成测试分类" bash "${ROOT_DIR}/tools/run_integration_tests.sh"
test_run_step "端到端测试分类" bash "${ROOT_DIR}/tools/run_e2e_tests.sh"
test_run_step "浏览器组件测试分类" bash "${ROOT_DIR}/tools/run_component_tests.sh"

# 性能测试由 tools/run_performance_tests.sh 独立执行，不进入常规全量正确性门禁。
test_cleanup_owned_server

if [[ "${YIMSG_QUALITY_GATES:-0}" == "1" ]]; then
  test_run_step "质量门禁" bash "${ROOT_DIR}/tools/scripts/check_quality.sh"
fi
