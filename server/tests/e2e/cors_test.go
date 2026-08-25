package e2e

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

// allowedEmbedOrigin 与 tools/scripts/tests/common.sh 写入测试配置的
// [server] allowed_origins 保持一致。
const allowedEmbedOrigin = "https://embed-host.example"

// deniedEmbedOrigin 是任意一个不在白名单里的来源。
const deniedEmbedOrigin = "https://not-allowed.example"

func corsHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
}

// requestWithOrigin 带 Origin 头发起请求并返回响应头，用于断言跨域许可。
func requestWithOrigin(t *testing.T, method, url, origin string, extra map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Origin", origin)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := corsHTTPClient().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

// TestCORSUikitBundleServedToAllowedOrigin 验证第三方站点能跨域加载 UIKit bundle：
// 白名单来源拿到 CORS 与资源策略头，且不再返回会挡住嵌入的跨域隔离头。
func TestCORSUikitBundleServedToAllowedOrigin(t *testing.T) {
	resp := requestWithOrigin(t, http.MethodGet, httpBaseURL+"/uikit/yimsg-uikit.js", allowedEmbedOrigin, nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /uikit/yimsg-uikit.js = %d, want 200（需先构建前端产物）", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowedEmbedOrigin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, allowedEmbedOrigin)
	}
	if got := resp.Header.Get("Cross-Origin-Resource-Policy"); got != "cross-origin" {
		t.Fatalf("Cross-Origin-Resource-Policy = %q, want cross-origin", got)
	}
	// 浏览器端已不使用 SQLite/OPFS，不需要跨域隔离；这两个头会让跨域宿主页
	// 无法引用 bundle，必须确认已经彻底移除。
	if got := resp.Header.Get("Cross-Origin-Opener-Policy"); got != "" {
		t.Fatalf("Cross-Origin-Opener-Policy = %q, want 空", got)
	}
	if got := resp.Header.Get("Cross-Origin-Embedder-Policy"); got != "" {
		t.Fatalf("Cross-Origin-Embedder-Policy = %q, want 空", got)
	}
}

// TestCORSUikitBundleDeniedForUnknownOrigin 验证白名单外的站点拿不到跨域许可。
func TestCORSUikitBundleDeniedForUnknownOrigin(t *testing.T) {
	resp := requestWithOrigin(t, http.MethodGet, httpBaseURL+"/uikit/yimsg-uikit.js", deniedEmbedOrigin, nil)
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("未授权来源不应获得跨域许可，得到 %q", got)
	}
}

// TestCORSUploadPreflight 验证带 Authorization 的跨域上传能通过预检。
func TestCORSUploadPreflight(t *testing.T) {
	resp := requestWithOrigin(t, http.MethodOptions, httpUploadURL, allowedEmbedOrigin, map[string]string{
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "authorization,content-type",
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("预检状态码 = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowedEmbedOrigin {
		t.Fatalf("预检 Access-Control-Allow-Origin = %q, want %q", got, allowedEmbedOrigin)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); got != "authorization,content-type" {
		t.Fatalf("预检 Access-Control-Allow-Headers = %q, want 回显请求头", got)
	}
	if resp.Header.Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("预检响应缺少 Access-Control-Allow-Methods")
	}
}

// TestCORSUploadPreflightDeniedForUnknownOrigin 验证未授权来源的预检被直接拒绝。
func TestCORSUploadPreflightDeniedForUnknownOrigin(t *testing.T) {
	resp := requestWithOrigin(t, http.MethodOptions, httpUploadURL, deniedEmbedOrigin, map[string]string{
		"Access-Control-Request-Method": "POST",
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("未授权来源的预检状态码 = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

// TestCORSUploadAndMediaCrossOrigin 走完整跨域链路：从白名单来源上传图片，
// 再按返回的相对路径跨域读取媒体文件。
func TestCORSUploadAndMediaCrossOrigin(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("cors"), "pass1234", "CorsUploader")

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("category", "image")
	part, _ := w.CreateFormFile("file", "cors.png")
	part.Write(minimalPNG)
	w.Close()

	req, err := http.NewRequest(http.MethodPost, httpUploadURL, &buf)
	if err != nil {
		t.Fatalf("build upload request: %v", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Origin", allowedEmbedOrigin)

	resp, err := corsHTTPClient().Do(req)
	if err != nil {
		t.Fatalf("cross-origin upload: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("跨域上传状态码 = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowedEmbedOrigin {
		t.Fatalf("上传响应 Access-Control-Allow-Origin = %q, want %q", got, allowedEmbedOrigin)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read upload response: %v", err)
	}
	var uploaded uploadResponse
	if err := json.Unmarshal(body, &uploaded); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if !uploaded.OK || uploaded.URL == "" {
		t.Fatalf("跨域上传失败：ok=%v error=%s", uploaded.OK, uploaded.Error)
	}

	mediaResp := requestWithOrigin(t, http.MethodGet, httpBaseURL+uploaded.URL, allowedEmbedOrigin, nil)
	defer mediaResp.Body.Close()

	if mediaResp.StatusCode != http.StatusOK {
		t.Fatalf("跨域读取媒体状态码 = %d, want 200", mediaResp.StatusCode)
	}
	if got := mediaResp.Header.Get("Access-Control-Allow-Origin"); got != allowedEmbedOrigin {
		t.Fatalf("媒体响应 Access-Control-Allow-Origin = %q, want %q", got, allowedEmbedOrigin)
	}
	if got := mediaResp.Header.Get("Cross-Origin-Resource-Policy"); got != "cross-origin" {
		t.Fatalf("媒体响应 Cross-Origin-Resource-Policy = %q, want cross-origin", got)
	}
}

// TestCORSMediaDeniedForUnknownOrigin 验证媒体文件同样只对白名单来源开放跨域许可。
func TestCORSMediaDeniedForUnknownOrigin(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("cors"), "pass1234", "CorsUploader")
	uploaded := uploadFile(t, c.token, "image", "denied.png", minimalPNG)
	if !uploaded.OK {
		t.Fatalf("准备媒体文件失败：%s", uploaded.Error)
	}

	resp := requestWithOrigin(t, http.MethodGet, httpBaseURL+uploaded.URL, deniedEmbedOrigin, nil)
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("未授权来源不应获得媒体跨域许可，得到 %q", got)
	}
}
