#!/usr/bin/env bash
# 运行 Go 单元测试（排除 server/tests/e2e）并计算总体行覆盖率，与阈值比较。
#
# 用法：
#   ./tools/scripts/check_go_coverage.sh                    # 默认阈值 55%
#   MIN_COVERAGE=60 ./tools/scripts/check_go_coverage.sh    # 自定义阈值
#
# 输出：
#   - /tmp/yimsg-go-coverage.out （coverprofile 原始文件）
#   - 控制台打印各包覆盖率明细、总行覆盖率、是否达标
#
# 退出码：
#   0 达标；1 未达到阈值；其它为工具错误。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

MIN_COVERAGE="${MIN_COVERAGE:-55}"
COVERAGE_OUT="${COVERAGE_OUT:-/tmp/yimsg-go-coverage.out}"

echo "==== Go 覆盖率 (阈值 ${MIN_COVERAGE}%) ===="

# 对 server/internal/ 生产代码包统计覆盖率。
# 排除：
#   - server/cmd/yimsg-server：仅是进程入口，依赖真实端口/依赖注入，由 E2E 黑盒覆盖；
#   - server/tests/e2e：黑盒测试本身；
#   - tools：辅助脚本。
pkgs=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && pkgs+=("${line}")
done < <(go list ./server/internal/...)

if [[ "${#pkgs[@]}" -eq 0 ]]; then
  echo "未找到需要统计覆盖率的 Go 包"
  exit 2
fi

go test -count=1 -covermode=atomic -coverprofile="${COVERAGE_OUT}" "${pkgs[@]}"

total_line=$(go tool cover -func="${COVERAGE_OUT}" | awk '/^total:/{print $NF}')
total_pct="${total_line%\%}"

if [[ -z "${total_pct}" ]]; then
  echo "无法从 coverprofile 解析总体覆盖率"
  exit 2
fi

printf '总体覆盖率: %s%%\n' "${total_pct}"
printf '阈值:       %s%%\n' "${MIN_COVERAGE}"

# 用 awk 做浮点比较，避免依赖 bc。
# awk 退出码：0 表示通过（coverage >= threshold），1 表示未达标。
if ! awk -v c="${total_pct}" -v t="${MIN_COVERAGE}" 'BEGIN{exit !(c+0 >= t+0)}'; then
  echo "❌ Go 覆盖率 ${total_pct}% 低于阈值 ${MIN_COVERAGE}%"
  exit 1
fi

echo "✅ Go 覆盖率达标"
