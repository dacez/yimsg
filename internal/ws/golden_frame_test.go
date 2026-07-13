package ws

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"

	"yimsg/internal/protocol/pb"
)

// 以下常量是 Go / TypeScript 共享的 protobuf frame 字节样例（golden vector）。
// 两侧分别硬编码同一组数据（见 frontend/tests/unit/sdk/protocol-golden-frame.test.ts），
// 不再通过共享 JSON fixture 文件中转；修改帧格式时需要同步更新两侧常量。
const (
	goldenUsername = "alice"
	goldenPassword = "pass"
	goldenBodyHex  = "5205616c6963655a0470617373"
)

type goldenFrameCase struct {
	Name         string
	LittleEndian bool
	Magic        byte
	Codec        byte
	Reserved     byte
	Checksum     byte
	Size         uint16
	RequestID    uint64
	Type         uint16
	BodyHex      string
	FrameHex     string
}

var goldenFrameCases = []goldenFrameCase{
	{
		Name:         "login_request_big_endian",
		LittleEndian: false,
		Magic:        77,
		Codec:        2,
		Reserved:     0,
		Checksum:     227,
		Size:         13,
		RequestID:    72623859790382856,
		Type:         2,
		BodyHex:      goldenBodyHex,
		FrameHex:     "4d0200e3000d010203040506070800025205616c6963655a0470617373",
	},
	{
		Name:         "login_request_little_endian",
		LittleEndian: true,
		Magic:        77,
		Codec:        3,
		Reserved:     0,
		Checksum:     48,
		Size:         13,
		RequestID:    72623859790382856,
		Type:         2,
		BodyHex:      goldenBodyHex,
		FrameHex:     "4d0300300d00080706050403020102005205616c6963655a0470617373",
	},
}

func TestGoldenLoginFrames(t *testing.T) {
	body, err := proto.Marshal(&pb.LoginRequest{
		Username: goldenUsername,
		Password: goldenPassword,
	})
	if err != nil {
		t.Fatalf("marshal login request: %v", err)
	}
	if got := hex.EncodeToString(body); got != goldenBodyHex {
		t.Fatalf("protobuf body hex=%s, want %s", got, goldenBodyHex)
	}

	for _, tc := range goldenFrameCases {
		t.Run(tc.Name, func(t *testing.T) {
			wantFrame := decodeHex(t, tc.FrameHex)
			wantBody := decodeHex(t, tc.BodyHex)
			if string(wantBody) != string(body) {
				t.Fatalf("fixture body mismatch")
			}

			assertGoldenHeaderBytes(t, wantFrame, tc)

			endian := FrameEndianBig
			if tc.LittleEndian {
				endian = FrameEndianLittle
			}
			encoded, err := EncodeFrameWithEndian(FrameCodecProtobuf, endian, tc.RequestID, tc.Type, body)
			if err != nil {
				t.Fatalf("encode frame: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != tc.FrameHex {
				t.Fatalf("encoded frame hex=%s, want %s", got, tc.FrameHex)
			}

			frame, err := DecodeFrame(wantFrame)
			if err != nil {
				t.Fatalf("decode golden frame: %v", err)
			}
			if frame.RequestID != tc.RequestID || frame.Type != tc.Type || string(frame.Body) != string(body) {
				t.Fatalf("decoded frame=%+v", frame)
			}
			var decoded pb.LoginRequest
			if err := proto.Unmarshal(frame.Body, &decoded); err != nil {
				t.Fatalf("unmarshal golden body: %v", err)
			}
			if decoded.Username != goldenUsername || decoded.Password != goldenPassword {
				t.Fatalf("decoded login request username=%q password=%q", decoded.Username, decoded.Password)
			}
		})
	}
}

func assertGoldenHeaderBytes(t *testing.T, frame []byte, tc goldenFrameCase) {
	t.Helper()
	if len(frame) != FrameHeaderSize+int(tc.Size) {
		t.Fatalf("frame len=%d, want %d", len(frame), FrameHeaderSize+int(tc.Size))
	}
	if frame[frameMagicOffset] != tc.Magic {
		t.Fatalf("magic=0x%02x, want 0x%02x", frame[frameMagicOffset], tc.Magic)
	}
	if frame[frameCodecOffset] != tc.Codec {
		t.Fatalf("codec=0x%02x, want 0x%02x", frame[frameCodecOffset], tc.Codec)
	}
	if frame[frameReservedOffset] != tc.Reserved {
		t.Fatalf("reserved=0x%02x, want 0x%02x", frame[frameReservedOffset], tc.Reserved)
	}
	if frame[frameChecksumOffset] != tc.Checksum {
		t.Fatalf("checksum=0x%02x, want 0x%02x", frame[frameChecksumOffset], tc.Checksum)
	}
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	data, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode hex %q: %v", value, err)
	}
	return data
}
