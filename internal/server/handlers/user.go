package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/bestruirui/octopus/internal/server/auth"
	"github.com/bestruirui/octopus/internal/server/middleware"
	"github.com/bestruirui/octopus/internal/server/resp"
	"github.com/bestruirui/octopus/internal/server/router"
	"github.com/charmbracelet/log"
	"github.com/gin-gonic/gin"
)

func init() {
	router.NewGroupRouter("/api/v1/user").
		Use(middleware.RequireJSON()).
		AddRoute(
			router.NewRoute("/login", http.MethodPost).
				Handle(login),
		)
	// 会话 Cookie 是 HttpOnly, 只能由服务端清除; 退出登录不校验会话, 过期或无效时也能清掉。
	// RequireJSON 让浏览器之外的跨站表单提交无法触达该路由, 避免被别人的页面强制登出。
	router.NewGroupRouter("/api/v1/user").
		Use(middleware.RequireJSON()).
		AddRoute(
			router.NewRoute("/logout", http.MethodPost).
				Handle(logout),
		)
	router.NewGroupRouter("/api/v1/user").
		Use(middleware.Auth()).
		Use(middleware.RequireJSON()).
		AddRoute(
			router.NewRoute("/change-password", http.MethodPost).
				Handle(changePassword),
		).
		AddRoute(
			router.NewRoute("/change-username", http.MethodPost).
				Handle(changeUsername),
		).
		AddRoute(
			router.NewRoute("/status", http.MethodGet).
				Handle(status),
		)
}

func login(c *gin.Context) {
	var user model.UserLogin
	if err := c.ShouldBindJSON(&user); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	clientKey := loginClientKey(c)
	blocked, wait := loginBlocked(clientKey)
	// 先校验口令再决定是否退避: 如果退避期间连正确口令都拒绝, 任何能触发 5 次失败的
	// 人都能把管理员挡在面板外 (个人网关只有这一个账号, 客户端 IP 又可能因反代而相同)。
	if err := op.UserVerify(user.Username, user.Password); err != nil {
		if blocked {
			resp.Error(c, http.StatusTooManyRequests, fmt.Sprintf("too many failed login attempts, retry in %s", wait.Round(time.Second)))
			return
		}
		loginFailed(clientKey)
		resp.Error(c, http.StatusUnauthorized, resp.ErrUnauthorized)
		return
	}
	loginSucceeded(clientKey)
	token, maxAge, err := auth.GenerateJWTToken(user.Expire)
	if err != nil {
		resp.Error(c, http.StatusInternalServerError, resp.ErrInternalServer)
		return
	}
	// HttpOnly 阻断脚本读取会话; SameSite=Lax 阻断跨站表单提交。
	setSessionCookie(c, token, maxAge)
	resp.Success(c, "login successfully")
}

func logout(c *gin.Context) {
	setSessionCookie(c, "", -1)
	resp.Success(c, "logout successfully")
}

// setSessionCookie 写入或清除会话 Cookie: HttpOnly 阻断脚本读取, SameSite=Lax 阻断跨站表单提交,
// 只在 https 下带 Secure, 本地 http 部署仍可用。
func setSessionCookie(c *gin.Context, value string, maxAge int) {
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("auth", value, maxAge, "/", "", secure, true)
}

func changePassword(c *gin.Context) {
	var user model.UserChangePassword
	if err := c.ShouldBindJSON(&user); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	if err := op.UserChangePassword(user.OldPassword, user.NewPassword); err != nil {
		// 用户输入类错误回显原因; 数据库与加密故障不回显内部细节。
		if errors.Is(err, op.ErrIncorrectOldPassword) || errors.Is(err, op.ErrInvalidNewPassword) {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		log.Errorf("change password failed: %v", err)
		resp.Error(c, http.StatusInternalServerError, resp.ErrDatabase)
		return
	}
	resp.Success(c, "password changed successfully")
}

func changeUsername(c *gin.Context) {
	var user model.UserChangeUsername
	if err := c.ShouldBindJSON(&user); err != nil {
		resp.Error(c, http.StatusBadRequest, resp.ErrInvalidJSON)
		return
	}
	if err := op.UserChangeUsername(user.NewUsername); err != nil {
		if errors.Is(err, op.ErrInvalidNewUsername) {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		log.Errorf("change username failed: %v", err)
		resp.Error(c, http.StatusInternalServerError, resp.ErrDatabase)
		return
	}
	resp.Success(c, "username changed successfully")
}

func status(c *gin.Context) {
	resp.Success(c, "ok")
}
