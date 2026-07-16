// Package msgid 提供消息 ID 的统一表示：UUIDv7 的 base64url（无填充）编码，固定 22 字符。
//
// 业务约束（见 CLAUDE.md / docs）：
//   - msg_id 在整个项目中永远是 string，禁止任何二进制 UUID 表示。
//   - 用户消息的 msg_id 只允许由 TypeScript SDK 生成；服务端只做校验、保存、回传与幂等。
//   - 系统消息由服务端发起、无 SDK 来源，是唯一允许服务端生成 msg_id（Generate）的消息类型。
package msgid

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// Length 是 msg_id 的固定字符串长度：16 字节经 base64url 无填充编码为 22 字符。
const Length = 22

// rawLen 是底层 UUID 的字节长度。
const rawLen = 16

// Generate 生成一个新的 msg_id（UUIDv7 的 base64url 编码）。
// 仅用于服务端发起的系统消息这一例外场景，用户消息的 msg_id 必须由 SDK 生成。
func Generate() string {
	var b [rawLen]byte
	ms := uint64(time.Now().UnixMilli())
	// 48-bit 毫秒时间戳。
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	// 随机填充剩余 10 字节。
	if _, err := rand.Read(b[6:]); err != nil {
		panic(fmt.Sprintf("msgid: rand read failed: %v", err))
	}
	// version = 7（高 4 位）。
	b[6] = (b[6] & 0x0f) | 0x70
	// variant = 0b10（高 2 位）。
	b[8] = (b[8] & 0x3f) | 0x80
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// Validate 校验 msg_id 是否为合法的 UUIDv7 base64url 表示：
// 长度固定 22、base64url 合法、可解码为 16 字节、version=7、variant=0b10。
func Validate(id string) error {
	if len(id) != Length {
		return fmt.Errorf("msg_id 长度必须为 %d，实际为 %d", Length, len(id))
	}
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return fmt.Errorf("msg_id 不是合法的 base64url: %w", err)
	}
	if len(raw) != rawLen {
		return fmt.Errorf("msg_id 解码后长度必须为 %d 字节，实际为 %d", rawLen, len(raw))
	}
	if raw[6]&0xf0 != 0x70 {
		return fmt.Errorf("msg_id version 必须为 7")
	}
	if raw[8]&0xc0 != 0x80 {
		return fmt.Errorf("msg_id variant 必须为 0b10")
	}
	return nil
}
