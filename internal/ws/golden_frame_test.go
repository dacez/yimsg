package ws

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"google.golang.org/protobuf/proto"

	"yimsg/internal/protocol/pb"
)

type goldenFrameFile struct {
	Protobuf struct {
		Message  string `json:"message"`
		Username string `json:"username"`
		Password string `json:"password"`
		BodyHex  string `json:"body_hex"`
	} `json:"protobuf"`
	Frames []goldenFrameCase `json:"frames"`
}

type goldenFrameCase struct {
	Name         string `json:"name"`
	LittleEndian bool   `json:"little_endian"`
	Magic        byte   `json:"magic"`
	Codec        byte   `json:"codec"`
	Reserved     byte   `json:"reserved"`
	Checksum     byte   `json:"checksum"`
	Size         uint16 `json:"size"`
	RequestID    uint64 `json:"request_id,string"`
	Type         uint16 `json:"type"`
	BodyHex      string `json:"body_hex"`
	FrameHex     string `json:"frame_hex"`
}

func TestGoldenLoginFrames(t *testing.T) {
	fixture := readGoldenFrameFixture(t)
	body, err := proto.Marshal(&pb.LoginRequest{
		Username: fixture.Protobuf.Username,
		Password: fixture.Protobuf.Password,
	})
	if err != nil {
		t.Fatalf("marshal login request: %v", err)
	}
	if got := hex.EncodeToString(body); got != fixture.Protobuf.BodyHex {
		t.Fatalf("protobuf body hex=%s, want %s", got, fixture.Protobuf.BodyHex)
	}

	for _, tc := range fixture.Frames {
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
			if decoded.Username != fixture.Protobuf.Username || decoded.Password != fixture.Protobuf.Password {
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

func readGoldenFrameFixture(t *testing.T) goldenFrameFile {
	t.Helper()
	data, err := os.ReadFile("../../tests/fixtures/protocol/golden_frames.json")
	if err != nil {
		t.Fatalf("read golden fixture: %v", err)
	}
	var fixture goldenFrameFile
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse golden fixture: %v", err)
	}
	return fixture
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	data, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode hex %q: %v", value, err)
	}
	return data
}
