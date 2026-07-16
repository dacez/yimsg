package e2e

import (
	"flag"
	"fmt"
	"os"
	"testing"
	"time"
)

var (
	serverHost    = "localhost"
	serverPort    = 8080
	serverTLS     = true
	configPath    = ""
	wsURL         string
	httpUploadURL string
	httpBaseURL   string

	// runPrefix is a unique prefix for this test run (e.g. "e2e_1679012345").
	// All test data (usernames, nicknames, group names) use this prefix to
	// avoid conflicts with manually created data and prior test runs.
	// Each run accumulates data in the database, allowing stability testing
	// under growing data volume.
	runPrefix string
)

func TestMain(m *testing.M) {
	flag.StringVar(&serverHost, "host", "localhost", "server host")
	flag.IntVar(&serverPort, "port", 8080, "server port")
	flag.BoolVar(&serverTLS, "tls", true, "use TLS (wss/https); set -tls=false for plain ws/http")
	flag.StringVar(&configPath, "config", "", "server config path; 组织建制不上协议，org e2e 需经配置直连数据目录（与 test-seed 同先例），缺省时跳过 org 用例")
	flag.Parse()

	wsScheme := "wss"
	httpScheme := "https"
	if !serverTLS {
		wsScheme = "ws"
		httpScheme = "http"
	}

	wsURL = fmt.Sprintf("%s://%s:%d/ws", wsScheme, serverHost, serverPort)
	httpBaseURL = fmt.Sprintf("%s://%s:%d", httpScheme, serverHost, serverPort)
	httpUploadURL = httpBaseURL + "/api/upload"

	// Generate a unique prefix for this test run based on Unix timestamp.
	// Format: "e2e_1679012345" — human-readable, easy to grep in database.
	runPrefix = fmt.Sprintf("e2e_%d", time.Now().Unix())

	os.Exit(m.Run())
}
