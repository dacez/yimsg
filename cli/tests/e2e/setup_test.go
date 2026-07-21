// Package e2e 针对已经启动的真实 yimsg 服务端，端到端驱动 cli/cmd/yimsg-cli
// 编译出的二进制（而不是直接调用 cli 内部包），验证 AI 实际会调用的命令行接口本身
// 可用：login 保存 token、sync 落库、send/history/pending/user-info/
// group-info/contacts 均按 JSON 输出契约工作。与 server/tests/e2e 的运行方式一致：
// 由 tools/scripts/run_all_tests.sh 先启动服务端，再传入 -host/-port/-tls 运行本包。
package e2e

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var (
	serverHost string
	serverPort int
	serverTLS  bool
	wsURL      string

	cliBinary string
	runPrefix string
)

func TestMain(m *testing.M) {
	flag.StringVar(&serverHost, "host", "localhost", "server host")
	flag.IntVar(&serverPort, "port", 8080, "server port")
	flag.BoolVar(&serverTLS, "tls", true, "use TLS (wss); set -tls=false for plain ws")
	flag.Parse()

	scheme := "wss"
	if !serverTLS {
		scheme = "ws"
	}
	wsURL = fmt.Sprintf("%s://%s:%d/ws", scheme, serverHost, serverPort)
	runPrefix = fmt.Sprintf("clie2e_%d", time.Now().Unix())

	bin, cleanup, err := buildCLI()
	if err != nil {
		fmt.Fprintf(os.Stderr, "build yimsg-cli: %v\n", err)
		os.Exit(1)
	}
	cliBinary = bin
	code := m.Run()
	cleanup()
	os.Exit(code)
}

// buildCLI 编译 cli/cmd/yimsg-cli 到临时目录，供各测试用例以子进程方式驱动，
// 这样测的是 AI 实际调用的命令行二进制本身，而不是内部包函数。
func buildCLI() (string, func(), error) {
	out, err := exec.Command("go", "env", "GOMOD").Output()
	if err != nil {
		return "", nil, fmt.Errorf("go env GOMOD: %w", err)
	}
	repoRoot := filepath.Dir(strings.TrimSpace(string(out)))

	tmpDir, err := os.MkdirTemp("", "yimsg-cli-e2e-bin")
	if err != nil {
		return "", nil, err
	}
	binPath := filepath.Join(tmpDir, "yimsg-cli")
	cmd := exec.Command("go", "build", "-o", binPath, "./cli/cmd/yimsg-cli")
	cmd.Dir = repoRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		os.RemoveAll(tmpDir)
		return "", nil, fmt.Errorf("go build: %w\n%s", err, out)
	}
	return binPath, func() { os.RemoveAll(tmpDir) }, nil
}

func uniqueName(prefix string) string {
	return fmt.Sprintf("%s_%s_%d", runPrefix, prefix, time.Now().UnixNano())
}
