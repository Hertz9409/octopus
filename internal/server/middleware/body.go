package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// maxJSONBodySize 是面板普通接口的请求体上限: 面板没有上传入口, 而网关的 /v1 请求由转发链路自行处理。
const maxJSONBodySize = 4 << 20

// maxImportBodySize 是设置导入接口的上限: 备份包含全部渠道、分组与统计, 会比普通请求大得多。
const maxImportBodySize = 64 << 20

// importPath 是唯一允许大请求体的面板接口 (multipart 或 JSON 形式的备份文件)。
const importPath = "/api/v1/setting/import"

// LimitJSONBody 在读取请求体之前设上限, 避免超大请求体在鉴权之前就被读进内存。
func LimitJSONBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		switch {
		case strings.HasPrefix(path, "/api/"):
			limit := int64(maxJSONBodySize)
			if path == importPath {
				limit = maxImportBodySize
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}
