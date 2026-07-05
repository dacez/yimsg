#!/usr/bin/env bash
# 汇总质量门禁：Go 覆盖率 + 前端覆盖率 + 前后端重复率。
# 作为 CI 质量趋势指标统一入口。
#
# 环境变量：
#   MIN_GO_COVERAGE        Go 行覆盖率阈值，默认 55；透传给 check_go_coverage.sh。
#   前端覆盖率阈值          由 frontend/vitest.config.ts 的 coverage.thresholds 决定；
#                          临时下调需同步 docs/测试方案.md 留痕。
#   重复率阈值              由 .jscpd.json 的 threshold 决定（默认 3%）。
#
# 依赖：
#   - 已安装 Go（进入仓库即有）；
#   - 已安装 frontend/node_modules（脚本会自动 npm ci）。
#
# 用法：
#   ./tools/scripts/check_quality.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

FAILED=()

run_step() {
  local name="$1"
  shift
  echo
  echo "==== [${name}] ===="
  if ! "$@"; then
    echo "❌ 质量门禁失败: ${name}"
    FAILED+=("${name}")
  else
    echo "✅ 质量门禁通过: ${name}"
  fi
}

ensure_frontend_deps() {
  if [[ ! -d "${ROOT_DIR}/frontend/node_modules" ]]; then
    echo "frontend/node_modules 不存在，执行 npm ci"
    (cd "${ROOT_DIR}/frontend" && npm ci)
  fi
}

# 1) Go 覆盖率
run_step "go-coverage" bash "${ROOT_DIR}/tools/scripts/check_go_coverage.sh"

# 2) 前端单测覆盖率（依赖 @vitest/coverage-v8），保留 vitest 自身的 text-summary 输出便于肉眼观察。
ensure_frontend_deps
run_step "frontend-coverage" bash -c "cd '${ROOT_DIR}/frontend' && npm run test:unit:coverage"

# 3) 代码重复率（jscpd 覆盖 Go + TS 源码），必须从仓库根目录运行以使
#    .jscpd.json 中的相对 glob 正确解析。
JSCPD_BIN="${ROOT_DIR}/frontend/node_modules/.bin/jscpd"
if [[ ! -x "${JSCPD_BIN}" ]]; then
  echo "未找到 jscpd 可执行文件：${JSCPD_BIN}"
  FAILED+=("duplication:missing")
else
  run_step "duplication" "${JSCPD_BIN}" --config "${ROOT_DIR}/.jscpd.json" "${ROOT_DIR}"
fi

echo
if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "质量门禁未通过的步骤: ${FAILED[*]}"
  exit 1
fi

echo "🎉 所有质量门禁通过"
