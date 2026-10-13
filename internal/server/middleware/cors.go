package middleware

import (
	"net/http"
	"strings"

	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/gin-gonic/gin"
)

// Cors 处理跨域请求:
//   - 白名单为空: 不下发任何 CORS 头;
//   - 白名单为 "*": 允许任意来源, 但不允许携带凭证 —— 否则任意站点都能带着面板会话 Cookie 调用接口;
//   - 白名单为域名列表: 只放行匹配的来源, 并允许携带凭证。
func Cors() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin == "" {
			c.Next()
			return
		}
		// 只要请求带了 Origin, 响应就随它变化 (含不下发 CORS 头的情况), 否则中间缓存可能
		// 把某一来源的响应复用给另一来源。
		c.Writer.Header().Add("Vary", "Origin")
		allowed, err := op.SettingGetString(model.SettingKeyCORSAllowOrigins)
		if err != nil {
			c.Next()
			return
		}
		allowed = strings.TrimSpace(allowed)
		if allowed == "" {
			c.Next()
			return
		}

		wildcard := allowed == "*"
		if !wildcard && !originAllowed(allowed, origin) {
			c.Next()
			return
		}

		if wildcard {
			c.Header("Access-Control-Allow-Origin", "*")
		} else {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
		}

		if c.Request.Method == http.MethodOptions {
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			if requested := c.GetHeader("Access-Control-Request-Headers"); requested != "" {
				c.Header("Access-Control-Allow-Headers", requested)
			} else {
				c.Header("Access-Control-Allow-Headers", "*")
			}
			c.Header("Access-Control-Max-Age", "86400")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Header("Access-Control-Expose-Headers", "Content-Disposition")
		c.Next()
	}
}

// originAllowed 判断来源是否命中白名单; 白名单项可以是完整 origin (http://host:port) 或仅域名。
// 仅写域名的项按 https 理解: 放行的响应允许携带凭证, 不该被 http 页面拿到。
func originAllowed(allowed, origin string) bool {
	scheme, originHost := origin, origin
	if idx := strings.Index(origin, "://"); idx != -1 {
		scheme = origin[:idx]
		originHost = origin[idx+3:]
	}
	originHost = strings.TrimRight(originHost, "/")

	for _, item := range strings.Split(allowed, ",") {
		item = strings.TrimSpace(item)
		item = strings.TrimRight(item, "/")
		if item == "" {
			continue
		}
		if strings.Contains(item, "://") {
			if item == origin {
				return true
			}
			continue
		}
		if strings.EqualFold(scheme, "https") && item == originHost {
			return true
		}
	}
	return false
}
