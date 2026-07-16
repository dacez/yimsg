// Package auth provides password hashing, token generation, and token authentication.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"time"

	"yimsg/server/internal/config"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/shard"

	"golang.org/x/crypto/bcrypt"
)

// hashCost 是 bcrypt 哈希成本，默认使用生产安全强度 bcrypt.DefaultCost。
// 可通过环境变量 YIMSG_BCRYPT_COST 覆盖：测试环境把成本降到 bcrypt.MinCost，
// 能在保持哈希算法与校验逻辑不变（不降低测试强度）的前提下，把单次哈希耗时从
// ~67ms 降到 ~1ms，大幅缩短大量注册场景的测试时间。生产部署不设置该变量即保持默认。
var hashCost = loadHashCost()

func loadHashCost() int {
	if v := os.Getenv("YIMSG_BCRYPT_COST"); v != "" {
		if c, err := strconv.Atoi(v); err == nil && c >= bcrypt.MinCost && c <= bcrypt.MaxCost {
			return c
		}
	}
	return bcrypt.DefaultCost
}

// HashPassword hashes a password using bcrypt.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), hashCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword checks a password against a bcrypt hash.
func VerifyPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// GenerateToken generates a random hex token of the given byte length.
func GenerateToken(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// NowMs returns the current time in milliseconds since Unix epoch.
func NowMs() int64 {
	return time.Now().UnixMilli()
}

// Authenticate validates a token and returns the uid. Auto-renews if less than half TTL remaining.
func Authenticate(tokenShards *shard.Group, cfg *config.SessionConfig, token string) (int64, error) {
	store := dal.NewSessionStore(tokenShards.RouteStr(token))
	sess, err := store.Get(token)
	if err != nil {
		return 0, fmt.Errorf("authenticate: %w", err)
	}
	if sess == nil {
		return 0, ErrInvalidToken
	}

	now := NowMs()
	if sess.ExpireAt <= now {
		return 0, ErrTokenExpired
	}

	ttlMs := cfg.TTLSeconds * 1000
	if sess.ExpireAt-now < ttlMs/2 {
		_ = store.Renew(token, now+ttlMs)
	}

	return sess.UID, nil
}
