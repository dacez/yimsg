#!/usr/bin/env bash

# 测试分类脚本共用的环境、输出和临时服务端生命周期。
# 本文件只提供函数，source 时不主动安装依赖、构建或启动进程。

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_PROTOC_GEN_GO_VERSION="v1.36.11"
TEST_PLAYWRIGHT_MIRROR_HOST="https://npmmirror.com/mirrors/playwright"
TEST_SERVER_OWNED=false
TEST_SERVER_PID=""
TEST_SERVER_TMP_DIR=""
TEST_SERVER_LOG=""

TEST_IS_WINDOWS=false
case "$(uname -s)" in
  MINGW*|CYGWIN*|MSYS*) TEST_IS_WINDOWS=true ;;
esac

TEST_EXE_EXT=""
if $TEST_IS_WINDOWS; then
  TEST_EXE_EXT=".exe"
fi

if $TEST_IS_WINDOWS && [[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="C:/ms-playwright-browsers"
fi

export YIMSG_BCRYPT_COST="${YIMSG_BCRYPT_COST:-4}"

test_run_step() {
  local name="$1"
  shift
  echo
  echo "==== [${name}] ===="
  if ! "$@"; then
    echo "[FAIL] ${name}" >&2
    return 1
  fi
  echo "[PASS] ${name}"
}

test_retry_network() {
  local max="${YIMSG_NET_RETRY:-4}"
  local delay=2
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= max )); then
      echo "网络命令连续失败 ${attempt} 次，停止重试: $*" >&2
      return 1
    fi
    echo "网络命令失败，${delay}s 后重试，第 $((attempt + 1))/${max} 次: $*" >&2
    sleep "${delay}"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

test_ensure_node_modules() {
  if [[ "${YIMSG_TEST_NODE_DEPS_READY:-0}" == "1" ]]; then
    return 0
  fi
  cd "${TEST_ROOT_DIR}"
  if [[ ! -d node_modules ]]; then
    test_retry_network npm ci
  fi
}

test_ensure_go_modules() {
  if [[ "${YIMSG_TEST_GO_DEPS_READY:-0}" == "1" ]]; then
    return 0
  fi
  cd "${TEST_ROOT_DIR}"
  test_retry_network go mod download
}

test_ensure_go_codegen_deps() {
  cd "${TEST_ROOT_DIR}"
  local gopath
  gopath="$(go env GOPATH)"
  if [[ -z "${gopath}" ]]; then
    echo "无法读取 GOPATH，不能安装 protoc-gen-go" >&2
    return 1
  fi
  mkdir -p "${gopath}/bin"
  local bin="${gopath}/bin/protoc-gen-go${TEST_EXE_EXT}"
  if [[ -x "${bin}" ]] && "${bin}" --version 2>/dev/null | grep -q "${TEST_PROTOC_GEN_GO_VERSION}"; then
    echo "protoc-gen-go ${TEST_PROTOC_GEN_GO_VERSION} 已就绪"
    return 0
  fi
  test_retry_network env GOBIN="${gopath}/bin" \
    go install "google.golang.org/protobuf/cmd/protoc-gen-go@${TEST_PROTOC_GEN_GO_VERSION}"
}

test_playwright_browser_ready() {
  cd "${TEST_ROOT_DIR}"
  node -e "require('@playwright/test').chromium.launch({channel:'chromium'}).then(b=>b.close()).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

test_ensure_playwright_browser() {
  if [[ "${YIMSG_TEST_PLAYWRIGHT_READY:-0}" == "1" \
        || "${YIMSG_SKIP_PLAYWRIGHT_INSTALL:-0}" == "1" \
        || "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-0}" == "1" ]]; then
    return 0
  fi
  cd "${TEST_ROOT_DIR}"
  if test_playwright_browser_ready; then
    echo "Playwright Chromium 已就绪"
    return 0
  fi

  local with_deps=()
  if [[ "${YIMSG_PLAYWRIGHT_WITH_DEPS:-0}" == "1" ]]; then
    with_deps=(--with-deps)
  fi
  local max="${YIMSG_NET_RETRY:-4}"
  local per_attempt_timeout="${YIMSG_PLAYWRIGHT_DOWNLOAD_TIMEOUT:-150}"
  local user_download_host="${PLAYWRIGHT_DOWNLOAD_HOST:-}"
  local delay=2
  local attempt=1
  while (( attempt <= max )); do
    local host="${user_download_host}"
    if [[ -z "${host}" && ${attempt} -gt 1 ]]; then
      host="${TEST_PLAYWRIGHT_MIRROR_HOST}"
    fi
    echo "安装 Playwright Chromium，第 ${attempt}/${max} 次，单次超时 ${per_attempt_timeout}s${host:+，下载源=${host}}"
    PLAYWRIGHT_DOWNLOAD_HOST="${host}" timeout "${per_attempt_timeout}" \
      npx playwright install ${with_deps[@]+"${with_deps[@]}"} chromium || true
    if test_playwright_browser_ready; then
      echo "Playwright Chromium 已就绪"
      return 0
    fi
    if (( attempt < max )); then
      echo "Chromium 尚未就绪，${delay}s 后重试" >&2
      sleep "${delay}"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done
  echo "Playwright Chromium 安装后仍不可用" >&2
  return 1
}

test_wait_http_ready() {
  local url="$1"
  local max_retry="${2:-60}"
  local i
  for ((i=1; i<=max_retry; i++)); do
    if curl -sS --max-time 2 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

test_find_free_port() {
  local host="${1:-127.0.0.1}"
  node -e '
const net = require("node:net");
const host = process.argv[1];
const server = net.createServer();
server.on("error", (error) => {
  console.error(`无法分配测试端口: ${error.message}`);
  process.exitCode = 1;
});
server.listen({ host, port: 0, exclusive: true }, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("无法读取测试端口");
    process.exitCode = 1;
    server.close();
    return;
  }
  console.log(address.port);
  server.close();
});
' "${host}"
}

test_write_server_config() {
  local config_file="$1"
  local data_dir="$2"
  local host="$3"
  local port="$4"
  mkdir -p "${data_dir}/media"
  cat > "${config_file}" <<EOF
[server]
host = "${host}"
port = ${port}
machine_id = 1
tls_cert = ""
tls_key = ""

[database]
data_dir = "${data_dir}"
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
upload_dir = "${data_dir}/media"
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

test_ensure_server() {
  local configured_host="${YIMSG_TEST_SERVER_HOST:-}"
  local configured_port="${YIMSG_TEST_SERVER_PORT:-}"
  local configured_config="${YIMSG_TEST_CONFIG:-}"

  if [[ -n "${configured_config}" ]]; then
    if [[ -z "${configured_host}" || -z "${configured_port}" ]]; then
      echo "复用测试服务端时必须同时提供 YIMSG_TEST_SERVER_HOST、YIMSG_TEST_SERVER_PORT 和 YIMSG_TEST_CONFIG" >&2
      return 1
    fi
    if [[ ! -f "${configured_config}" ]]; then
      echo "测试配置不存在: ${configured_config}" >&2
      return 1
    fi
    if ! test_wait_http_ready "http://${configured_host}:${configured_port}/" 3; then
      echo "复用的测试服务端未就绪: ${configured_host}:${configured_port}" >&2
      return 1
    fi
    return 0
  fi

  test_ensure_go_modules
  TEST_SERVER_TMP_DIR="$(mktemp -d)"
  local host="${configured_host:-127.0.0.1}"
  local port="${configured_port:-}"
  if [[ -z "${port}" ]]; then
    port="$(test_find_free_port "${host}")"
  fi
  local config_file="${TEST_SERVER_TMP_DIR}/config.toml"
  local data_dir="${TEST_SERVER_TMP_DIR}/data"
  local server_bin="${YIMSG_PREBUILT_SERVER:-${TEST_SERVER_TMP_DIR}/server${TEST_EXE_EXT}}"
  TEST_SERVER_LOG="${TEST_SERVER_TMP_DIR}/server.log"

  test_write_server_config "${config_file}" "${data_dir}" "${host}" "${port}"
  cd "${TEST_ROOT_DIR}"
  if [[ ! -f "${server_bin}" ]]; then
    test_run_step "构建测试服务端" go build -o "${server_bin}" ./server/cmd/yimsg-server
  fi
  "${server_bin}" "${config_file}" >"${TEST_SERVER_LOG}" 2>&1 &
  TEST_SERVER_PID=$!
  TEST_SERVER_OWNED=true

  if ! test_wait_http_ready "http://${host}:${port}/" 30 \
      || ! kill -0 "${TEST_SERVER_PID}" 2>/dev/null; then
    echo "测试服务端未就绪，日志如下:" >&2
    cat "${TEST_SERVER_LOG}" >&2 || true
    return 1
  fi

  export YIMSG_TEST_SERVER_HOST="${host}"
  export YIMSG_TEST_SERVER_PORT="${port}"
  export YIMSG_TEST_CONFIG="${config_file}"
  export YIMSG_PREBUILT_SERVER="${server_bin}"
}

test_cleanup_owned_server() {
  if [[ "${TEST_SERVER_OWNED}" == "true" \
        && -n "${TEST_SERVER_PID}" \
        && "${TEST_SERVER_PID}" =~ ^[0-9]+$ ]]; then
    if kill -0 "${TEST_SERVER_PID}" 2>/dev/null; then
      kill "${TEST_SERVER_PID}" 2>/dev/null || true
      for _ in {1..20}; do
        if ! kill -0 "${TEST_SERVER_PID}" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "${TEST_SERVER_PID}" 2>/dev/null; then
        if $TEST_IS_WINDOWS; then
          taskkill /PID "${TEST_SERVER_PID}" /T /F 2>/dev/null || true
        else
          kill -KILL "${TEST_SERVER_PID}" 2>/dev/null || true
        fi
      fi
    fi
    wait "${TEST_SERVER_PID}" 2>/dev/null || true
  fi
  TEST_SERVER_PID=""
  TEST_SERVER_OWNED=false

  if [[ -n "${TEST_SERVER_TMP_DIR}" && -d "${TEST_SERVER_TMP_DIR}" ]]; then
    local resolved_tmp_dir
    resolved_tmp_dir="$(cd "${TEST_SERVER_TMP_DIR}" && pwd -P)"
    if [[ "${resolved_tmp_dir}" == /* \
          && "${resolved_tmp_dir}" != "/" \
          && "${resolved_tmp_dir}" != "${TEST_ROOT_DIR}" ]]; then
      rm -rf -- "${resolved_tmp_dir}"
    else
      echo "拒绝清理未通过路径校验的临时目录: ${resolved_tmp_dir}" >&2
    fi
  fi
  TEST_SERVER_TMP_DIR=""
}
