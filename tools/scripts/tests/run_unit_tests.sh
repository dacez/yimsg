#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

cd "${TEST_ROOT_DIR}"
test_ensure_go_modules
test_ensure_node_modules

go_packages=()
while IFS= read -r package; do
  [[ -n "${package}" ]] && go_packages+=("${package}")
done < <(go list ./... | grep -v -E '/tests/e2e(/|$)')

if [[ "${#go_packages[@]}" -eq 0 ]]; then
  echo "没有发现 Go 非 E2E 包" >&2
  exit 1
fi

test_run_step "Go 单元与包级测试" go test -count=1 "${go_packages[@]}"
test_run_step "SDK 单元测试" npm run test:unit
test_run_step "UIKit 单元测试" npm run test:uikit
test_run_step "Web 单元测试" npm run test:web
