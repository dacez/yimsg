package e2e

import (
	"crypto/tls"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestWebsiteServedOnRootPath 验证官网（纯静态营销站）被服务端挂载在根路径
// 作为首页，聊天 App 挂载在 /chat/ 子路径，二者不互相覆盖。测试服务端使用
// 默认 [website]/[frontend] 配置（website mount_path = "/"，frontend
// mount_path = "/chat/"），工作目录为仓库根。
func TestWebsiteServedOnRootPath(t *testing.T) {
	httpClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}

	resp, err := httpClient.Get(httpBaseURL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), "yimsg") {
		t.Fatalf("expected / to serve official site HTML containing %q", "yimsg")
	}

	// 官网静态资源也应可访问。
	cssResp, err := httpClient.Get(httpBaseURL + "/assets/style.css")
	if err != nil {
		t.Fatalf("GET /assets/style.css: %v", err)
	}
	defer cssResp.Body.Close()
	if cssResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /assets/style.css, got %d", cssResp.StatusCode)
	}

	// 聊天 App 应挂载在 /chat/，不被官网覆盖。
	chatResp, err := httpClient.Get(httpBaseURL + "/chat/")
	if err != nil {
		t.Fatalf("GET /chat/: %v", err)
	}
	defer chatResp.Body.Close()
	if chatResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /chat/, got %d", chatResp.StatusCode)
	}
	chatBody, err := io.ReadAll(chatResp.Body)
	if err != nil {
		t.Fatalf("read chat body: %v", err)
	}
	if !strings.Contains(string(chatBody), "<title>yimsg</title>") {
		t.Fatalf("expected /chat/ to serve the chat app HTML")
	}
}
