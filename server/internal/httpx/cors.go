// Package httpx 提供 HTTP 层的跨域策略：允许来源判定、CORS 响应头写入和预检处理。
//
// yimsg 的典型集成形态是「客户把服务端部署到自己的一台机器，第三方站点直接嵌入
// UIKit」，宿主站点与服务端天然不同源，因此 UIKit bundle、上传接口和媒体文件都
// 需要按配置放行跨域访问。未配置 allowed_origins 时策略整体关闭，同源部署的响应
// 头保持原样。
package httpx

import (
	"net/http"
	"net/url"
	"strings"
)

// 预检结果缓存时长（秒）。上传接口带 Authorization 头，每次上传都会先发预检，
// 缓存一天可以避免重复往返。
const preflightMaxAge = "86400"

// 未回显请求头时允许的默认请求头集合：上传接口需要 Authorization，
// FormData 提交需要 Content-Type。
const defaultAllowHeaders = "Authorization, Content-Type"

// OriginPolicy 按配置的允许来源列表判定请求来源是否放行。
// 零值不可用，必须通过 NewOriginPolicy 构造。
type OriginPolicy struct {
	allowAll bool
	allowed  map[string]bool
}

// NewOriginPolicy 按配置构造来源策略。列表为空表示不开启跨域，
// 含 "*" 表示放行任意来源。
func NewOriginPolicy(origins []string) *OriginPolicy {
	p := &OriginPolicy{allowed: make(map[string]bool, len(origins))}
	for _, origin := range origins {
		trimmed := strings.TrimSpace(origin)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			p.allowAll = true
			continue
		}
		p.allowed[strings.ToLower(strings.TrimSuffix(trimmed, "/"))] = true
	}
	return p
}

// Enabled 表示是否配置了任何允许来源。未开启时中间件不改动响应，
// WebSocket 升级也保持放行所有来源的既有行为。
func (p *OriginPolicy) Enabled() bool {
	return p.allowAll || len(p.allowed) > 0
}

// AllowRequest 判断请求来源是否放行。
//
// 三类请求始终放行：不带 Origin 的非浏览器客户端（CLI、Agent、curl）、
// 与服务端自身同源的页面、以及策略未开启时的全部请求。
func (p *OriginPolicy) AllowRequest(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if !p.Enabled() {
		return true
	}
	if p.allowAll {
		return true
	}
	if sameOrigin(origin, r.Host) {
		return true
	}
	return p.allowed[strings.ToLower(strings.TrimSuffix(origin, "/"))]
}

// allowOriginHeader 返回应写入 Access-Control-Allow-Origin 的值，
// 空串表示本次响应不追加跨域头。
func (p *OriginPolicy) allowOriginHeader(r *http.Request) string {
	if !p.Enabled() {
		return ""
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return ""
	}
	if p.allowAll {
		return "*"
	}
	if sameOrigin(origin, r.Host) || p.allowed[strings.ToLower(strings.TrimSuffix(origin, "/"))] {
		return origin
	}
	return ""
}

// sameOrigin 比较 Origin 头与请求自身 Host 是否指向同一主机端口。
// 服务端可能位于反向代理之后，无法可靠判定自身 scheme，因此只比较 host:port——
// 对「同一部署既提供页面又提供接口」这一唯一用途已经足够。
func sameOrigin(origin, host string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Host, host)
}

// Wrap 用跨域中间件包裹 handler：为放行的来源写入 CORS 与资源策略响应头，
// 并直接响应预检请求。策略未开启时原样透传。
func (p *OriginPolicy) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowOrigin := p.allowOriginHeader(r)
		if allowOrigin != "" {
			header := w.Header()
			header.Set("Access-Control-Allow-Origin", allowOrigin)
			// 允许来源随请求变化，缓存必须按 Origin 分桶。
			header.Add("Vary", "Origin")
			// 允许被跨域隔离的宿主页引用（bundle、媒体文件都是公开只读资源）。
			header.Set("Cross-Origin-Resource-Policy", "cross-origin")
		}

		if isPreflight(r) {
			if allowOrigin == "" {
				// 未放行的来源不给出任何跨域许可，浏览器据此中止真实请求。
				w.WriteHeader(http.StatusForbidden)
				return
			}
			header := w.Header()
			header.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			if requested := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers")); requested != "" {
				header.Set("Access-Control-Allow-Headers", requested)
			} else {
				header.Set("Access-Control-Allow-Headers", defaultAllowHeaders)
			}
			header.Set("Access-Control-Max-Age", preflightMaxAge)
			header.Add("Vary", "Access-Control-Request-Headers")
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isPreflight 判断是否是 CORS 预检请求。
func isPreflight(r *http.Request) bool {
	return r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != ""
}
