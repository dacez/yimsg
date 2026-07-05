package msgid

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// decodeTimestamp 取出 base64url 解码后的前 48 位毫秒时间戳。
func decodeTimestamp(t *testing.T, id string) uint64 {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		t.Fatalf("解码 %q 失败: %v", id, err)
	}
	if len(raw) != rawLen {
		t.Fatalf("解码后长度 = %d, 期望 %d", len(raw), rawLen)
	}
	return uint64(raw[0])<<40 | uint64(raw[1])<<32 | uint64(raw[2])<<24 |
		uint64(raw[3])<<16 | uint64(raw[4])<<8 | uint64(raw[5])
}

func TestGenerateProducesValidUUIDv7(t *testing.T) {
	id := Generate()

	if err := Validate(id); err != nil {
		t.Fatalf("Generate 产出的 id 未通过 Validate: %v", err)
	}
	if len(id) != Length {
		t.Fatalf("长度 = %d, 期望 %d", len(id), Length)
	}

	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		t.Fatalf("base64url 解码失败: %v", err)
	}
	if len(raw) != 16 {
		t.Fatalf("解码后字节数 = %d, 期望 16", len(raw))
	}
	if raw[6]&0xf0 != 0x70 {
		t.Fatalf("version 位 = %#x, 期望高 4 位为 0x7", raw[6])
	}
	if raw[8]&0xc0 != 0x80 {
		t.Fatalf("variant 位 = %#x, 期望高 2 位为 0b10", raw[8])
	}
}

func TestGenerateUnique(t *testing.T) {
	a := Generate()
	b := Generate()
	if a == b {
		t.Fatalf("连续两次 Generate 不应相等: %q", a)
	}
}

func TestGenerateTimeOrdered(t *testing.T) {
	first := Generate()
	time.Sleep(5 * time.Millisecond)
	second := Generate()

	tsFirst := decodeTimestamp(t, first)
	tsSecond := decodeTimestamp(t, second)
	if tsSecond < tsFirst {
		t.Fatalf("后生成的时间戳 %d 应 >= 先生成的 %d", tsSecond, tsFirst)
	}
}

func TestValidateRejectsBadInput(t *testing.T) {
	valid := Generate()
	rawValid, err := base64.RawURLEncoding.DecodeString(valid)
	if err != nil {
		t.Fatalf("解码合法 id 失败: %v", err)
	}

	// 构造 version 非 7 的 id。
	badVersion := make([]byte, rawLen)
	copy(badVersion, rawValid)
	badVersion[6] = (badVersion[6] & 0x0f) | 0x40 // version=4
	badVersionID := base64.RawURLEncoding.EncodeToString(badVersion)

	// 构造 variant 非 0b10 的 id。
	badVariant := make([]byte, rawLen)
	copy(badVariant, rawValid)
	badVariant[8] = (badVariant[8] & 0x3f) | 0xc0 // variant=0b11
	badVariantID := base64.RawURLEncoding.EncodeToString(badVariant)

	cases := []struct {
		name string
		id   string
	}{
		{"长度过短", "short"},
		{"长度过长", valid + "x"},
		{"非法 base64url 字符", strings.Repeat("*", Length)},
		{"version 非 7", badVersionID},
		{"variant 非 0b10", badVariantID},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := Validate(c.id); err == nil {
				t.Fatalf("Validate(%q) = nil, 期望返回错误", c.id)
			}
		})
	}
}
