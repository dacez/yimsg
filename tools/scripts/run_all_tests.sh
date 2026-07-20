#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="$ROOT_DIR"

# Detect Windows (Git Bash / MSYS2 / Cygwin)
IS_WINDOWS=false
case "$(uname -s)" in
  MINGW*|CYGWIN*|MSYS*) IS_WINDOWS=true ;;
esac

EXE_EXT=""
if $IS_WINDOWS; then EXE_EXT=".exe"; fi

# 部分 Windows 环境下 %LOCALAPPDATA% 会被宿主打包机制静默重定向（例如指向
# ...\Packages\<PackageFamilyName>\LocalCache\Local\...）；普通文件 API 能透明
# 读到重定向后的内容，但 chrome.exe 依赖的 side-by-side 清单加载走的是另一套
# 路径解析，找不到重定向目录下的清单文件，导致启动报 "side-by-side
# configuration is incorrect"（与 VC++ 运行库无关，装运行库不能解决）。未显式
# 指定 PLAYWRIGHT_BROWSERS_PATH 时，Windows 下固定装到 %LOCALAPPDATA% 之外，
# 避开该重定向。
if $IS_WINDOWS && [[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="C:/ms-playwright-browsers"
fi

SERVER_HOST="127.0.0.1"
SERVER_PORT=38081
PROTOC_GEN_GO_VERSION="v1.36.11"
# Playwright 官方下载源在部分网络环境下会时快时慢甚至连接被拒；未显式指定
# PLAYWRIGHT_DOWNLOAD_HOST 时，重试从第 2 次起自动切换到该镜像。
PLAYWRIGHT_MIRROR_HOST="https://npmmirror.com/mirrors/playwright"

# 测试环境统一把 bcrypt 哈希成本降到最低（MinCost=4）。
# 哈希算法与校验逻辑完全不变，仅去掉生产级抗暴力成本，
# 使大量注册场景（Go 单测、E2E、SDK 集成、Playwright 种子）显著提速而不降低测试强度。
# 生产部署不设置该变量，保持默认 DefaultCost。
export YIMSG_BCRYPT_COST=4

# 网络相关步骤统一走指数退避重试（2s/4s/8s/16s），降低沙箱/CI 中
# npm、playwright、go module 等因瞬时网络抖动导致的整轮失败概率。
# 可用 YIMSG_NET_RETRY 覆盖最大尝试次数（默认 4）。
retry() {
  local max="${YIMSG_NET_RETRY:-4}"
  local delay=2 attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= max )); then
      echo "命令连续失败 ${attempt} 次，放弃重试：$*" >&2
      return 1
    fi
    echo "命令失败，${delay}s 后重试（第 $((attempt + 1))/${max} 次）：$*" >&2
    sleep "${delay}"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
}

TMP_DIR="$(mktemp -d)"
CONFIG_FILE="${TMP_DIR}/config.toml"
SERVER_BIN="${TMP_DIR}/server${EXE_EXT}"
SERVER_LOG="${TMP_DIR}/server.log"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  kill_port_users "${SERVER_PORT}"
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

wait_http_ready() {
  local url="$1"
  local max_retry="${2:-60}"
  local i
  for ((i=1; i<=max_retry; i++)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

read_lines_into_array() {
  local __dest_name="$1"
  local __source_cmd="$2"
  local __line
  local __result=()

  while IFS= read -r __line; do
    [[ -n "${__line}" ]] && __result+=("${__line}")
  done < <(eval "${__source_cmd}")

  eval "${__dest_name}=()"
  if [[ "${#__result[@]}" -gt 0 ]]; then
    local __quoted=()
    local __item
    for __item in "${__result[@]}"; do
      __quoted+=("$(printf '%q' "${__item}")")
    done
    eval "${__dest_name}=(${__quoted[*]})"
  fi
}

kill_port_users() {
  local port="$1"

  if $IS_WINDOWS; then
    local pids
    pids=$(powershell -NoProfile -Command \
      "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique" \
      2>/dev/null | tr -d '\r' || true)
    if [[ -n "$pids" ]]; then
      echo "清理占用端口 ${port} 的进程: $(echo "$pids" | tr '\n' ' ')"
      echo "$pids" | xargs -I{} taskkill /PID {} /F 2>/dev/null || true
    fi
  else
    local pids=()
    read_lines_into_array pids "lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true"
    if [[ "${#pids[@]}" -eq 0 ]]; then
      return 0
    fi
    echo "清理占用端口 ${port} 的进程: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true
    sleep 1
    read_lines_into_array pids "lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true"
    if [[ "${#pids[@]}" -gt 0 ]]; then
      kill -9 "${pids[@]}" 2>/dev/null || true
    fi
  fi
}

ensure_go_codegen_deps() {
  cd "${ROOT_DIR}"
  local gopath
  gopath="$(go env GOPATH)"
  if [[ -z "${gopath}" ]]; then
    echo "无法读取 GOPATH，不能安装 protoc-gen-go" >&2
    return 1
  fi
  mkdir -p "${gopath}/bin"
  # 已安装目标版本则跳过 go install，避免每轮都联网拉取模块。
  local bin="${gopath}/bin/protoc-gen-go${EXE_EXT}"
  if [[ -x "${bin}" ]] && "${bin}" --version 2>/dev/null | grep -q "${PROTOC_GEN_GO_VERSION}"; then
    echo "protoc-gen-go ${PROTOC_GEN_GO_VERSION} 已安装，跳过安装"
    return 0
  fi
  retry env GOBIN="${gopath}/bin" go install "google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VERSION}"
}

ensure_frontend_deps() {
  cd "${ROOT_DIR}"
  if [[ ! -d node_modules ]]; then
    retry npm ci
  fi
  ensure_playwright_browser
  cd "${ROOT_DIR}"
}

# 判断 UI 测试所需的浏览器是否已可用：直接以 playwright.config 所用的
# channel: 'chromium'（完整 chromium 构建）尝试无头启动，成功即就绪。
# 这是版本精确、与配置一致的判据，比按目录名猜测可靠。
playwright_browser_ready() {
  node -e "require('@playwright/test').chromium.launch({channel:'chromium'}).then(b=>b.close()).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

# 安装 Playwright 浏览器。配置使用 channel: 'chromium'（完整 chromium 构建），
# 不依赖单独的 chrome-headless-shell——后者是额外大体积下载，在受限代理 / 沙箱
# 下最易被中断。但 `playwright install` 对 chromium 仍会顺带尝试下载 headless-shell，
# 该下载失败不影响 UI 测试，因此这里**以浏览器能否启动为成败判据**，而非 install
# 退出码：只要完整构建就绪即视为成功，避免被 headless-shell 下载失败误伤整轮测试。
ensure_playwright_browser() {
  cd "${ROOT_DIR}"
  if [[ "${YIMSG_SKIP_PLAYWRIGHT_INSTALL:-0}" == "1" \
        || "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-0}" == "1" ]]; then
    echo "已设置跳过标记，跳过 Playwright 浏览器安装"
    return 0
  fi
  if playwright_browser_ready; then
    echo "Playwright chromium 已就绪，跳过安装"
    return 0
  fi
  # 完整构建缺失时才下载，按指数退避重试；headless-shell 下载失败会让 install
  # 返回非 0，故不看其退出码，每轮结束后用启动探针判断是否已可用。
  # 需要系统依赖（libnss 等）时用 YIMSG_PLAYWRIGHT_WITH_DEPS=1 附加 --with-deps。
  local with_deps=()
  if [[ "${YIMSG_PLAYWRIGHT_WITH_DEPS:-0}" == "1" ]]; then
    with_deps=(--with-deps)
  fi
  local max="${YIMSG_NET_RETRY:-4}"
  local per_attempt_timeout="${YIMSG_PLAYWRIGHT_DOWNLOAD_TIMEOUT:-150}"
  # 用户已显式设置 PLAYWRIGHT_DOWNLOAD_HOST 时尊重其选择，全程不覆盖。
  local user_download_host="${PLAYWRIGHT_DOWNLOAD_HOST:-}"
  local delay=2 attempt=1
  while (( attempt <= max )); do
    local host="${user_download_host}"
    if [[ -z "${host}" && ${attempt} -gt 1 ]]; then
      host="${PLAYWRIGHT_MIRROR_HOST}"
    fi
    echo "安装 Playwright chromium（第 ${attempt}/${max} 次，单次超时 ${per_attempt_timeout}s${host:+，下载源=${host}}）..."
    # 单次尝试超过 per_attempt_timeout 未完成即视为太慢，直接放弃转入下一次
    # 重试（而非傻等它自然失败），下一次重试若未指定下载源则自动切镜像。
    PLAYWRIGHT_DOWNLOAD_HOST="${host}" timeout "${per_attempt_timeout}" \
      npx playwright install ${with_deps[@]+"${with_deps[@]}"} chromium || true
    if playwright_browser_ready; then
      echo "Playwright chromium 已就绪"
      return 0
    fi
    if (( attempt < max )); then
      echo "完整 chromium 构建尚未就绪，${delay}s 后重试" >&2
      sleep "${delay}"
      delay=$(( delay * 2 ))
    fi
    attempt=$(( attempt + 1 ))
  done
  echo "⚠️ Playwright chromium 仍不可用，UI 测试可能失败（详见其错误输出）" >&2
}

# 预先下载 Go 模块并隔离网络环节：后续 build / test 即可离线复用模块缓存，
# 把可能的网络抖动收敛到这一步并交给 retry 处理。
ensure_go_modules() {
  cd "${ROOT_DIR}"
  retry go mod download
}

build_frontend() {
  cd "${ROOT_DIR}"
  run_step "protocol codegen" go run ./tools/cmd/protocolgen
  npm run build
}

write_config() {
  cat > "${CONFIG_FILE}" <<EOF
[server]
host = "127.0.0.1"
port = ${SERVER_PORT}
machine_id = 1
tls_cert = ""
tls_key = ""

[database]
data_dir = "${TMP_DIR}/data"
shard_count = 4

[session]
ttl_seconds = 2592000
token_bytes = 32

[gc]
message_max_count = 100000
conversation_max_count = 10000
session_cleanup_interval_secs = 3600
contact_gc_interval_secs = 3600
message_gc_interval_secs = 3600
conversation_gc_interval_secs = 3600
user_gc_interval_secs = 3600

[frontend]
static_dir = "web"

[media]
upload_dir = "${TMP_DIR}/data/media"
max_avatar_bytes = 5242880
max_image_bytes = 10485760
max_file_bytes = 104857600

[client]
cache_ttl_seconds = 60
cache_max_entries = 1000

[message]
recall_window_seconds = 120

EOF
}

start_server() {
  go build -o "${SERVER_BIN}" ./server/cmd/yimsg-server
  "${SERVER_BIN}" "${CONFIG_FILE}" >"${SERVER_LOG}" 2>&1 &
  SERVER_PID=$!
  if ! wait_http_ready "http://${SERVER_HOST}:${SERVER_PORT}/" 30; then
    echo "yimsg server 未就绪，日志如下:"
    cat "${SERVER_LOG}" || true
    return 1
  fi
}

run_step() {
  local name="$1"
  shift
  echo
  echo "==== [${name}] ===="
  if ! "$@"; then
    echo "❌ 步骤失败: ${name}"
    return 1
  fi
  echo "✅ 步骤通过: ${name}"
}

run_tests() {
  run_step "docs consistency" bash "${ROOT_DIR}/tools/scripts/check_docs_consistency.sh"
  # 禁用 go test 缓存，确保任何回归都能在本次执行中被检测到。
  local go_pkgs=()
  read_lines_into_array go_pkgs "go list ./... | grep -v -E '^yimsg/(server|cli)/tests/e2e$'"
  run_step "go test (excluding server/tests/e2e, cli/tests/e2e)" go test -count=1 ${go_pkgs[@]+"${go_pkgs[@]}"}
  run_step "go test ./server/tests/e2e/... -tls=false" go test -count=1 -v -timeout=3m ./server/tests/e2e/... -tls=false -host="${SERVER_HOST}" -port="${SERVER_PORT}" -config="${CONFIG_FILE}"
  run_step "go test ./cli/tests/e2e/... -tls=false" go test -count=1 -v -timeout=3m ./cli/tests/e2e/... -tls=false -host="${SERVER_HOST}" -port="${SERVER_PORT}"
  (
    cd "${ROOT_DIR}"
    run_step "frontend sdk test:unit" npm run test:unit
    run_step "frontend sdk test:integration" env SERVER_WS_URL=ws://${SERVER_HOST}:${SERVER_PORT}/ws npm run test:sdk
    run_step "frontend uikit test" npm run test:uikit
    run_step "frontend web test" npm run test:web
    # Playwright globalSetup 复用脚本已编译的服务端二进制与已构建的 web/，避免重复 go build 与前端构建。
    run_step "frontend test:ui" env YIMSG_PREBUILT_SERVER="${SERVER_BIN}" YIMSG_SKIP_FRONTEND_BUILD=1 npm run test:e2e
  )
}

cd "${ROOT_DIR}"
kill_port_users "${SERVER_PORT}"
ensure_frontend_deps
ensure_go_codegen_deps
ensure_go_modules
build_frontend
write_config
start_server
run_tests
kill_port_users "${SERVER_PORT}"

# 质量门禁：默认不运行，设置 YIMSG_QUALITY_GATES=1 时附加执行。
# 主要用于 CI 每日趋势任务或合并前的质量校验，避免拖慢常规本地测试。
if [[ "${YIMSG_QUALITY_GATES:-0}" == "1" ]]; then
  run_step "quality-gates" bash "${ROOT_DIR}/tools/scripts/check_quality.sh"
fi
