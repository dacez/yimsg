package wire

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"

	"yimsg/protocol/generated/go/pb"
)

// goldenBodyHex / goldenFrameHex 与 server/internal/ws/golden_frame_test.go、
// packages/sdk/tests/unit/sdk/protocol-golden-frame.test.ts 使用同一份大端序
// golden vector，验证三份独立实现的帧字节完全一致。
const (
	goldenUsername = "alice"
	goldenPassword = "pass"
	goldenBodyHex  = "5205616c6963655a0470617373"
	goldenFrameHex = "4d0200e3000d010203040506070800025205616c6963655a0470617373"
	goldenReqID    = uint64(72623859790382856)
	goldenType     = uint16(2)
)

func TestGoldenLoginFrame(t *testing.T) {
	body, err := proto.Marshal(&pb.LoginRequest{Username: goldenUsername, Password: goldenPassword})
	if err != nil {
		t.Fatalf("marshal login request: %v", err)
	}
	if got := hex.EncodeToString(body); got != goldenBodyHex {
		t.Fatalf("body hex=%s, want %s", got, goldenBodyHex)
	}

	encoded, err := EncodeFrame(FrameCodecProtobuf, goldenReqID, goldenType, body)
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}
	if got := hex.EncodeToString(encoded); got != goldenFrameHex {
		t.Fatalf("encoded frame hex=%s, want %s", got, goldenFrameHex)
	}

	wantFrame, err := hex.DecodeString(goldenFrameHex)
	if err != nil {
		t.Fatalf("decode golden hex: %v", err)
	}
	frame, err := DecodeFrame(wantFrame)
	if err != nil {
		t.Fatalf("decode golden frame: %v", err)
	}
	if frame.RequestID != goldenReqID || frame.Type != goldenType || string(frame.Body) != string(body) {
		t.Fatalf("decoded frame=%+v", frame)
	}

	var decoded pb.LoginRequest
	if err := proto.Unmarshal(frame.Body, &decoded); err != nil {
		t.Fatalf("unmarshal golden body: %v", err)
	}
	if decoded.Username != goldenUsername || decoded.Password != goldenPassword {
		t.Fatalf("decoded login request username=%q password=%q", decoded.Username, decoded.Password)
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	body := []byte("hello yimsg cli")
	encoded, err := EncodeFrame(FrameCodecProtobuf, 42, 24, body)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	frame, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if frame.RequestID != 42 || frame.Type != 24 || string(frame.Body) != string(body) {
		t.Fatalf("round trip mismatch: %+v", frame)
	}
}

func TestEncodeFrameRejectsInvalidInput(t *testing.T) {
	if _, err := EncodeFrame(FrameCodecProtobuf, 1, 0, nil); err == nil {
		t.Fatalf("expected error for type=0")
	}
	if _, err := EncodeFrame(FrameCodec('x'), 1, 1, nil); err == nil {
		t.Fatalf("expected error for invalid codec")
	}
}

func TestDecodeFrameRejectsCorruption(t *testing.T) {
	encoded, err := EncodeFrame(FrameCodecProtobuf, 1, 1, []byte("payload"))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	corrupted := append([]byte(nil), encoded...)
	corrupted[len(corrupted)-1] ^= 0xff
	if _, err := DecodeFrame(corrupted); err == nil {
		t.Fatalf("expected checksum error for corrupted frame")
	}
	if _, err := DecodeFrame(encoded[:FrameHeaderSize-1]); err == nil {
		t.Fatalf("expected error for short frame")
	}
}
