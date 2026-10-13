package handlers

import (
	"net/http"

	"github.com/bestruirui/octopus/internal/op"
	"github.com/bestruirui/octopus/internal/server/middleware"
	"github.com/bestruirui/octopus/internal/server/resp"
	"github.com/bestruirui/octopus/internal/server/router"
	"github.com/gin-gonic/gin"
)

func init() {
	router.NewGroupRouter("/api/v1/catalog").
		Use(middleware.Auth()).
		Use(middleware.RequireJSON()).
		AddRoute(
			router.NewRoute("/models", http.MethodGet).
				Handle(listCatalogModels),
		)
}

// listCatalogModels 返回渠道在售模型与 models.dev 目录的对照结果, 也是模型库页面的数据来源。
// 目录未更新时 matched 全为 false, 页面按「未收录」展示, 不影响任何写操作。
func listCatalogModels(c *gin.Context) {
	items, summary := op.CatalogModelList()
	resp.Success(c, gin.H{"items": items, "summary": summary})
}
