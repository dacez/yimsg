package e2e

import (
	"crypto/tls"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestWebsiteServedOnRootPath 验证官网（纯静态营销站）被服务端挂载在根路径
// 作为首页，聊天相关静态资源挂载在 /app/、/demo/、/uikit/ 三个平级子路径下
// （真正需要注册登录的 App / 固定账号演示页 / 可嵌入第三方站点的 widget
// bundle），彼此没有共同的 /chat/ 前缀，也不被官网覆盖。测试服务端使用默认
// [website]/[frontend] 配置（website mount_path = "/"），工作目录为仓库根。
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

	// 真正需要注册登录的聊天 App 挂载在 /app/，不被官网覆盖。
	appResp, err := httpClient.Get(httpBaseURL + "/app/")
	if err != nil {
		t.Fatalf("GET /app/: %v", err)
	}
	defer appResp.Body.Close()
	if appResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /app/, got %d", appResp.StatusCode)
	}
	appBody, err := io.ReadAll(appResp.Body)
	if err != nil {
		t.Fatalf("read chat app body: %v", err)
	}
	if !strings.Contains(string(appBody), "<title>yimsg</title>") {
		t.Fatalf("expected /app/ to serve the chat app HTML")
	}

	// /demo/、/uikit/ 自身没有 index.html，挂载根路径显式 404 而不是回落到目录列表。
	for _, mountRoot := range []string{"/demo/", "/uikit/"} {
		mountResp, err := httpClient.Get(httpBaseURL + mountRoot)
		if err != nil {
			t.Fatalf("GET %s: %v", mountRoot, err)
		}
		mountResp.Body.Close()
		if mountResp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 from %s, got %d", mountRoot, mountResp.StatusCode)
		}
	}

	// 不再存在 /chat/ 前缀：落到官网的 catch-all 挂载点，官网目录下没有对应文件，自然 404。
	rootChatResp, err := httpClient.Get(httpBaseURL + "/chat/")
	if err != nil {
		t.Fatalf("GET /chat/: %v", err)
	}
	defer rootChatResp.Body.Close()
	if rootChatResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 from /chat/, got %d", rootChatResp.StatusCode)
	}
}
