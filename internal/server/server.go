package server

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/bestruirui/octopus/internal/conf"
	_ "github.com/bestruirui/octopus/internal/server/handlers"
	"github.com/bestruirui/octopus/internal/server/middleware"
	"github.com/bestruirui/octopus/internal/server/resp"
	"github.com/bestruirui/octopus/internal/server/router"
	"github.com/bestruirui/octopus/static"
	"github.com/charmbracelet/log"
	"github.com/gin-gonic/gin"
)

var httpSrv http.Server

func Start() error {
	if conf.IsDebug() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		resp.Error(c, http.StatusInternalServerError, resp.ErrInternalServer)
		c.Abort()
	}))

	if conf.IsDebug() {
		r.Use(middleware.Logger())
	}
	// 默认不信任任何代理头: 否则 X-Forwarded-For 可以被伪造成任意来源。
	if err := r.SetTrustedProxies(nil); err != nil {
		return err
	}
	r.Use(middleware.Cors())
	r.Use(middleware.LimitJSONBody())
	r.Use(middleware.StaticEmbed("/", static.StaticFS))

	if err := router.RegisterAll(r); err != nil {
		return err
	}

	httpSrv.Addr = fmt.Sprintf("%s:%d", conf.AppConfig.Server.Host, conf.AppConfig.Server.Port)
	httpSrv.Handler = r
	// 只限请求头读取与空闲连接: 流式响应与长请求体不受影响。
	httpSrv.ReadHeaderTimeout = 15 * time.Second
	httpSrv.IdleTimeout = 60 * time.Second
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Errorf("http server listen and serve error: %v", err)
		}
	}()
	return nil
}

// Shutdown 优雅停止 HTTP 服务: 停止接受新连接并等待在途请求结束, 流式响应有时间收尾。
func Shutdown() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return httpSrv.Shutdown(ctx)
}

func Close() error {
	return httpSrv.Close()
}
