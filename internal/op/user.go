package op

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/bestruirui/octopus/internal/db"
	"github.com/bestruirui/octopus/internal/model"
	"github.com/charmbracelet/log"
	"gorm.io/gorm"
)

var (
	userCacheLock sync.RWMutex // 同时保护 userCache 与 jwtSecret。
	userCache     model.User
	jwtSecret     []byte
)

// 用户输入类错误在此登记为哨兵值, 供调用方区分「请求不合法」与内部故障。
var (
	ErrIncorrectOldPassword = errors.New("incorrect old password")
	ErrInvalidNewPassword   = errors.New("new password must not be empty")
	ErrInvalidNewUsername   = errors.New("new username must not be empty")
)

// AuthSecretInit 载入会话签名密钥, 首次启动时随机生成并落库。
// 用随机密钥而不是用户名加口令哈希: 拿到 token 的人无法据此离线还原口令, 改密也只是轮换密钥。
func AuthSecretInit() error {
	value, err := SettingGetString(model.SettingKeyJWTSecret)
	if err != nil {
		return fmt.Errorf("failed to load jwt secret: %w", err)
	}
	if value == "" {
		return RotateJWTSecret()
	}
	userCacheLock.Lock()
	defer userCacheLock.Unlock()
	jwtSecret = []byte(value)
	return nil
}

// RotateJWTSecret 重新生成会话签名密钥, 使已签发的会话全部失效。
func RotateJWTSecret() error {
	userCacheLock.Lock()
	defer userCacheLock.Unlock()
	return rotateJWTSecretLocked()
}

func rotateJWTSecretLocked() error {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Errorf("failed to generate jwt secret: %w", err)
	}
	value := hex.EncodeToString(buf)
	if err := SettingSetString(model.SettingKeyJWTSecret, value); err != nil {
		return fmt.Errorf("failed to persist jwt secret: %w", err)
	}
	jwtSecret = []byte(value)
	return nil
}

// JWTSecret 返回会话签名密钥。
func JWTSecret() []byte {
	userCacheLock.RLock()
	defer userCacheLock.RUnlock()
	return jwtSecret
}

func UserInit() error {
	userCacheLock.Lock()
	defer userCacheLock.Unlock()

	err := db.GetDB().First(&userCache).Error
	if err == nil {
		if userCache.ComparePassword("admin") == nil {
			log.Warnf("user %s is still using the default password, change it in the account settings", userCache.Username)
		}
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return fmt.Errorf("failed to load user: %w", err)
	}
	userCache.Username = "admin"
	userCache.Password = "admin"
	if err := userCache.HashPassword(); err != nil {
		return err
	}
	if err := db.GetDB().Create(&userCache).Error; err != nil {
		return err
	}
	log.Infof("initial user: admin,password: admin")
	return nil
}

func UserChangePassword(oldPassword, newPassword string) error {
	if newPassword == "" {
		return ErrInvalidNewPassword
	}

	userCacheLock.Lock()
	defer userCacheLock.Unlock()

	if err := userCache.ComparePassword(oldPassword); err != nil {
		return fmt.Errorf("%w: %v", ErrIncorrectOldPassword, err)
	}

	updated := userCache
	updated.Password = newPassword
	if err := updated.HashPassword(); err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}
	if err := db.GetDB().Model(&model.User{}).Where("id = ?", userCache.ID).Update("password", updated.Password).Error; err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}
	userCache.Password = updated.Password

	// 改密后轮换会话密钥, 已签发的会话随之失效。
	return rotateJWTSecretLocked()
}

func UserChangeUsername(newUsername string) error {
	newUsername = strings.TrimSpace(newUsername)
	if newUsername == "" {
		return ErrInvalidNewUsername
	}

	userCacheLock.Lock()
	defer userCacheLock.Unlock()

	if userCache.Username == newUsername {
		return fmt.Errorf("new username is the same as the old username")
	}
	// 先写库, 成功后再更新内存, 避免库与内存分叉。
	if err := db.GetDB().Model(&model.User{}).Where("id = ?", userCache.ID).Update("username", newUsername).Error; err != nil {
		return fmt.Errorf("failed to update username: %w", err)
	}
	userCache.Username = newUsername
	return nil
}

func UserVerify(username, password string) error {
	userCacheLock.RLock()
	current := userCache
	userCacheLock.RUnlock()

	if username != current.Username {
		return fmt.Errorf("incorrect username")
	}
	if err := current.ComparePassword(password); err != nil {
		return fmt.Errorf("incorrect password")
	}
	return nil
}

func UserGet() model.User {
	userCacheLock.RLock()
	defer userCacheLock.RUnlock()
	return userCache
}
