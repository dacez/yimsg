// Package msgid 独立实现 CLI 侧的 msg_id 生成：UUIDv7 的 base64url（无填充）编码，固定 22 字符。
//
// 业务约束（见 CLAUDE.md）：msg_id 在整个项目中永远是 string；用户消息的 msg_id
// 必须由发起消息的客户端生成，服务端只校验、保存、回传与幂等。本 CLI 相当于
// 一个独立的 Go 客户端实现（与 TypeScript SDK、server/internal/msgid 一样各自
// 独立实现同一套 UUIDv7 base64url 方案，互不依赖），因此在此自行生成用户消息的 msg_id。
package msgid

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// Length 是 msg_id 的固定字符串长度：16 字节经 base64url 无填充编码为 22 字符。
const Length = 22

const rawLen = 16

// Generate 生成一个新的 msg_id（UUIDv7 的 base64url 编码）。
func Generate() string {
	var b [rawLen]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		panic(fmt.Sprintf("msgid: rand read failed: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x70 // version = 7
	b[8] = (b[8] & 0x3f) | 0x80 // variant = 0b10
	return base64.RawURLEncoding.EncodeToString(b[:])
}
