#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1#v}"
DIST_DIR="${2:-${ROOT_DIR}/dist}"

if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "版本号必须是语义化版本，例如 0.1.0；当前是 ${VERSION}" >&2
  exit 1
fi

cd "${ROOT_DIR}"

if [[ "${YIMSG_RELEASE_SKIP_BUILD:-0}" != "1" ]]; then
  go run ./tools/cmd/protocolgen --check
  npm run build
fi

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/.stage"

COMMIT="${YIMSG_RELEASE_COMMIT:-${GITHUB_SHA:-unknown}}"
COMMIT="${COMMIT:0:12}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LDFLAGS="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildDate=${BUILD_DATE}"

TARGETS=(
  "windows amd64 x86_64 zip"
  "linux amd64 x86_64 tar.gz"
  "linux arm64 arm64 tar.gz"
  "darwin arm64 arm64 tar.gz"
)

for target in "${TARGETS[@]}"; do
  read -r goos goarch label archive_type <<< "${target}"
  platform="${goos}"
  if [[ "${goos}" == "darwin" ]]; then
    platform="macos"
  fi
  package_name="yimsg-${VERSION}-${platform}-${label}"
  stage_root="${DIST_DIR}/.stage/${package_name}"
  mkdir -p "${stage_root}"

  ext=""
  if [[ "${goos}" == "windows" ]]; then
    ext=".exe"
  fi
  for cmd in "yimsg:./server/cmd/yimsg-server" "yimsg-cli:./cli/cmd/yimsg-cli" "yimsg-agent:./agent/cmd/yimsg-agent"; do
    bin_name="${cmd%%:*}"
    pkg_path="${cmd#*:}"
    CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
      go build -trimpath -ldflags "${LDFLAGS}" -o "${stage_root}/${bin_name}${ext}" "${pkg_path}"
  done

  cp -R web website "${stage_root}/"
  cp LICENSE NOTICE LICENSING.md "${stage_root}/"
  cp tools/release/README.zh-CN.txt tools/release/README.en.txt "${stage_root}/"
  cp config.toml "${stage_root}/config.example.toml"

  if [[ "${archive_type}" == "zip" ]]; then
    go run ./tools/cmd/package-release \
      --source "${stage_root}" \
      --output "${DIST_DIR}/${package_name}.zip"
  else
    go run ./tools/cmd/package-release \
      --source "${stage_root}" \
      --output "${DIST_DIR}/${package_name}.tar.gz"
  fi
done

(
  cd "${DIST_DIR}"
  sha256sum ./*.zip ./*.tar.gz > SHA256SUMS.txt
)
rm -rf "${DIST_DIR}/.stage"

echo "发行包已生成到 ${DIST_DIR}"
