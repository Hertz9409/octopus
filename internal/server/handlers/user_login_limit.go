package handlers

import (
	"net"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// 面板固定账号 admin, 端口一旦暴露就会被人扫密码; 这里按来源做失败退避,
// 只影响登录接口, 不影响已登录会话与网关接口。
const (
	loginFailThreshold = 5
	loginBaseLock      = 30 * time.Second
	loginMaxLock       = 15 * time.Minute
	loginStaleAfter    = 30 * time.Minute
	loginPruneAt       = 256
)

type loginAttempt struct {
	failures    int
	lockedUntil time.Time
	lastSeen    time.Time
}

var loginAttempts = struct {
	sync.Mutex
	byIP map[string]*loginAttempt
}{byIP: make(map[string]*loginAttempt)}

// loginClientKey 用 TCP 对端而不是 ClientIP: X-Forwarded-For 可以伪造, 用它做 key 等于没有限制。
func loginClientKey(c *gin.Context) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		return c.Request.RemoteAddr
	}
	return host
}

// loginBlocked 返回该来源是否处于退避期, 以及还要等多久。
func loginBlocked(key string) (bool, time.Duration) {
	loginAttempts.Lock()
	defer loginAttempts.Unlock()
	attempt, ok := loginAttempts.byIP[key]
	if !ok {
		return false, 0
	}
	remaining := time.Until(attempt.lockedUntil)
	if remaining > 0 {
		return true, remaining
	}
	return false, 0
}

// loginFailed 记录一次失败, 达到阈值后按指数退避锁定。
func loginFailed(key string) {
	loginAttempts.Lock()
	defer loginAttempts.Unlock()
	now := time.Now()
	attempt, ok := loginAttempts.byIP[key]
	if !ok {
		attempt = &loginAttempt{}
		loginAttempts.byIP[key] = attempt
	}
	attempt.failures++
	attempt.lastSeen = now
	if attempt.failures >= loginFailThreshold {
		lock := loginBaseLock << (attempt.failures - loginFailThreshold)
		if lock <= 0 || lock > loginMaxLock {
			lock = loginMaxLock
		}
		attempt.lockedUntil = now.Add(lock)
	}
	pruneLoginAttemptsLocked(now)
}

// loginSucceeded 登录成功后清掉该来源的失败记录。
func loginSucceeded(key string) {
	loginAttempts.Lock()
	defer loginAttempts.Unlock()
	delete(loginAttempts.byIP, key)
}

// pruneLoginAttemptsLocked 清理长期无活动的记录, 避免 map 随扫描无限增长。
func pruneLoginAttemptsLocked(now time.Time) {
	if len(loginAttempts.byIP) < loginPruneAt {
		return
	}
	for key, attempt := range loginAttempts.byIP {
		if now.Sub(attempt.lastSeen) > loginStaleAfter {
			delete(loginAttempts.byIP, key)
		}
	}
}
