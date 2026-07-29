package e2e

import (
	"crypto/tls"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"testing"
)

var websiteImageSourcePattern = regexp.MustCompile(`(?i)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']`)

func localWebsiteImagePaths(pageHTML string) []string {
	seen := make(map[string]struct{})
	var paths []string
	for _, match := range websiteImageSourcePattern.FindAllStringSubmatch(pageHTML, -1) {
		if len(match) != 2 {
			continue
		}
		src := strings.TrimSpace(match[1])
		if src == "" ||
			strings.HasPrefix(src, "data:") ||
			strings.HasPrefix(src, "http://") ||
			strings.HasPrefix(src, "https://") ||
			strings.HasPrefix(src, "//") {
			continue
		}
		if !strings.HasPrefix(src, "/") {
			src = "/" + strings.TrimPrefix(src, "./")
		}
		if _, exists := seen[src]; exists {
			continue
		}
		seen[src] = struct{}{}
		paths = append(paths, src)
	}
	return paths
}

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
	pageHTML := string(body)
	for _, marker := range []string{
		"data-i18n-html=\"customizeItem3\"",
		"data-i18n-html=\"customizeItem5\"",
		"data-i18n-html=\"customizeItem6\"",
		"一台机器，一次部署，多地、多端、多个产品共用。",
		"One machine. One deployment. Every location, device, and product.",
	} {
		if !strings.Contains(pageHTML, marker) {
			t.Fatalf("expected official site HTML to contain %q", marker)
		}
	}
	for _, obsoleteClaim := range []string{
		"Cluster deployment",
		"Stack more hosts",
		"multiple hosts scale out freely",
		"集群部署",
		"多台叠加",
		"互联互通",
	} {
		if strings.Contains(pageHTML, obsoleteClaim) {
			t.Fatalf("official site must not contain unsupported cluster claim %q", obsoleteClaim)
		}
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

	// 从页面提取所有本地图片并逐一访问，避免 HTML 与测试中的手写资产名单漂移。
	imagePaths := localWebsiteImagePaths(pageHTML)
	if len(imagePaths) == 0 {
		t.Fatal("expected official site HTML to reference at least one local image")
	}
	for _, imagePath := range imagePaths {
		assetResp, err := httpClient.Get(httpBaseURL + imagePath)
		if err != nil {
			t.Fatalf("GET %s: %v", imagePath, err)
		}
		assetBody, readErr := io.ReadAll(assetResp.Body)
		assetResp.Body.Close()
		if readErr != nil {
			t.Fatalf("read %s: %v", imagePath, readErr)
		}
		if assetResp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 from %s, got %d", imagePath, assetResp.StatusCode)
		}
		contentType := assetResp.Header.Get("Content-Type")
		if !strings.HasPrefix(contentType, "image/") {
			t.Fatalf("expected image content type from %s, got %q", imagePath, contentType)
		}
		switch path.Ext(imagePath) {
		case ".svg":
			if !strings.Contains(contentType, "image/svg+xml") || !strings.Contains(string(assetBody), "<svg") {
				t.Fatalf("expected %s to contain SVG markup with an SVG content type", imagePath)
			}
		case ".png":
			pngMagic := []byte{0x89, 'P', 'N', 'G'}
			if !strings.Contains(contentType, "image/png") ||
				len(assetBody) < len(pngMagic) ||
				!strings.HasPrefix(string(assetBody), string(pngMagic)) {
				t.Fatalf("expected %s to contain PNG bytes with a PNG content type", imagePath)
			}
		}
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
