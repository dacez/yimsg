package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestHandler 返回一个被跨域中间件包裹的最小 handler，
// 命中时写入固定 body，便于断言请求是否真的透传到下游。
func newTestHandler(origins []string) http.Handler {
	policy := NewOriginPolicy(origins)
	return policy.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
}

func TestCORSAllowedOriginGetsHeaders(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/uikit/yimsg-uikit.js", nil)
	req.Header.Set("Origin", "https://a.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://a.com" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want https://a.com", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("Vary = %q, want Origin", got)
	}
	if got := rec.Header().Get("Cross-Origin-Resource-Policy"); got != "cross-origin" {
		t.Fatalf("Cross-Origin-Resource-Policy = %q, want cross-origin", got)
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok（请求应透传到下游）", rec.Body.String())
	}
}

func TestCORSWildcardAllowsAnyOrigin(t *testing.T) {
	handler := newTestHandler([]string{"*"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/media/image/x", nil)
	req.Header.Set("Origin", "https://whatever.example")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

func TestCORSDisallowedOriginGetsNoHeaders(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/uikit/yimsg-uikit.js", nil)
	req.Header.Set("Origin", "https://evil.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want 空（未授权来源不得获得跨域许可）", got)
	}
	if got := rec.Header().Get("Cross-Origin-Resource-Policy"); got != "" {
		t.Fatalf("Cross-Origin-Resource-Policy = %q, want 空", got)
	}
}

func TestCORSRequestWithoutOriginPassesThrough(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/media/image/x", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("非浏览器请求应正常处理，得到 code=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("无 Origin 请求不应追加 CORS 头，得到 %q", got)
	}
}

func TestCORSPreflightReturnsAllowHeaders(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodOptions, "http://im.example.com/api/upload", nil)
	req.Header.Set("Origin", "https://a.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("预检状态码 = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("预检响应缺少 Access-Control-Allow-Methods")
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "authorization" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want authorization（回显请求头）", got)
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got != preflightMaxAge {
		t.Fatalf("Access-Control-Max-Age = %q, want %s", got, preflightMaxAge)
	}
	if rec.Body.String() != "" {
		t.Fatalf("预检不应透传到下游，body = %q", rec.Body.String())
	}
}

func TestCORSPreflightWithoutRequestHeadersUsesDefault(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodOptions, "http://im.example.com/api/upload", nil)
	req.Header.Set("Origin", "https://a.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != defaultAllowHeaders {
		t.Fatalf("Access-Control-Allow-Headers = %q, want %s", got, defaultAllowHeaders)
	}
}

func TestCORSPreflightFromDisallowedOriginIsRejected(t *testing.T) {
	handler := newTestHandler([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodOptions, "http://im.example.com/api/upload", nil)
	req.Header.Set("Origin", "https://evil.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("未授权来源的预检状态码 = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestCORSDisabledKeepsResponseUntouched(t *testing.T) {
	handler := newTestHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/uikit/yimsg-uikit.js", nil)
	req.Header.Set("Origin", "https://a.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("未配置 allowed_origins 时不应追加跨域头，得到 %q", got)
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok", rec.Body.String())
	}
}

func TestAllowRequestSameOriginAlwaysPasses(t *testing.T) {
	policy := NewOriginPolicy([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)
	req.Host = "im.example.com"
	req.Header.Set("Origin", "https://im.example.com")

	if !policy.AllowRequest(req) {
		t.Fatal("同源页面必须放行，否则自带的 /app/ 会被自己的白名单挡掉")
	}
}

func TestAllowRequestRejectsUnknownOrigin(t *testing.T) {
	policy := NewOriginPolicy([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)
	req.Host = "im.example.com"
	req.Header.Set("Origin", "https://evil.com")

	if policy.AllowRequest(req) {
		t.Fatal("白名单外来源必须拒绝")
	}
}

func TestAllowRequestWithoutOriginPasses(t *testing.T) {
	policy := NewOriginPolicy([]string{"https://a.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)

	if !policy.AllowRequest(req) {
		t.Fatal("CLI / Agent 等不带 Origin 的客户端必须放行")
	}
}

func TestAllowRequestDisabledPolicyPassesAll(t *testing.T) {
	policy := NewOriginPolicy(nil)
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)
	req.Header.Set("Origin", "https://evil.com")

	if !policy.AllowRequest(req) {
		t.Fatal("未配置 allowed_origins 时保持既有全放行行为")
	}
}

func TestAllowRequestWildcardPassesAll(t *testing.T) {
	policy := NewOriginPolicy([]string{"*"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)
	req.Header.Set("Origin", "https://evil.com")

	if !policy.AllowRequest(req) {
		t.Fatal("通配配置必须放行任意来源")
	}
}

func TestNewOriginPolicyNormalizesEntries(t *testing.T) {
	policy := NewOriginPolicy([]string{"  https://A.com/  ", "", "https://b.com"})
	req := httptest.NewRequest(http.MethodGet, "http://im.example.com/ws", nil)
	req.Host = "im.example.com"

	req.Header.Set("Origin", "https://a.com")
	if !policy.AllowRequest(req) {
		t.Fatal("配置项应忽略首尾空白、末尾斜杠与大小写差异")
	}
	req.Header.Set("Origin", "https://b.com")
	if !policy.AllowRequest(req) {
		t.Fatal("多来源配置应逐项生效")
	}
}
