// Package e2e 针对已启动的真实 yimsg 服务端 + 一个模拟 DeepSeek 接口的
// httptest.Server，编译并以子进程方式驱动 yimsg-agent 二进制本身，验证完整
// 轮询 → 拉取 → 调用 DeepSeek → 回复 → 状态落盘链路。运行方式与
// server/tests/e2e、cli/tests/e2e 一致，由 tools/scripts/run_all_tests.sh
// 先启动服务端，再传入 -host/-port/-tls 运行本包。
package e2e

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var (
	serverHost string
	serverPort int
	serverTLS  bool
	wsURL      string

	agentBinary string
	runPrefix   string
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
	runPrefix = fmt.Sprintf("agente2e_%d", time.Now().Unix())

	bin, cleanup, err := buildAgent()
	if err != nil {
		fmt.Fprintf(os.Stderr, "build yimsg-agent: %v\n", err)
		os.Exit(1)
	}
	agentBinary = bin
	code := m.Run()
	cleanup()
	os.Exit(code)
}

// buildAgent 编译 agent/cmd/yimsg-agent 到临时目录，供各测试用例以子进程方式
// 驱动，测的是实际会被部署运行的二进制本身，而不是内部包函数。
func buildAgent() (string, func(), error) {
	out, err := exec.Command("go", "env", "GOMOD").Output()
	if err != nil {
		return "", nil, fmt.Errorf("go env GOMOD: %w", err)
	}
	repoRoot := filepath.Dir(strings.TrimSpace(string(out)))

	tmpDir, err := os.MkdirTemp("", "yimsg-agent-e2e-bin")
	if err != nil {
		return "", nil, err
	}
	binName := "yimsg-agent"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	binPath := filepath.Join(tmpDir, binName)
	cmd := exec.Command("go", "build", "-o", binPath, "./agent/cmd/yimsg-agent")
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
