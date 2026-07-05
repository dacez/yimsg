package ws

import (
	"strings"
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/protocol/pb"
)

func TestFramePacketSizeLimitUsesWholePacket(t *testing.T) {
	if FrameHeaderSize != 16 {
		t.Fatalf("FrameHeaderSize=%d, want 16", FrameHeaderSize)
	}
	if MaxFrameBodySize != MaxFramePacketSize-FrameHeaderSize {
		t.Fatalf("MaxFrameBodySize=%d, want packet limit minus header", MaxFrameBodySize)
	}

	pingType, ok := ActionType(appmsg.ActionPing)
	if !ok {
		t.Fatal("missing ping interface id")
	}

	body := make([]byte, MaxFrameBodySize)
	if _, err := EncodeFrame(FrameCodecProtobuf, 1, pingType, body); err != nil {
		t.Fatalf("encode max frame body: %v", err)
	}

	body = append(body, 0)
	if _, err := EncodeFrame(FrameCodecProtobuf, 1, pingType, body); err == nil {
		t.Fatal("expected oversized frame body to be rejected")
	}
}

func TestDecodeRejectsPacketOver64K(t *testing.T) {
	data := make([]byte, MaxFramePacketSize+1)
	if _, err := DecodeFrame(data); err == nil {
		t.Fatal("expected oversized frame packet to be rejected")
	}
}

func TestNotificationNameIsNonZero(t *testing.T) {
	if pb.Type_TYPE_NOTIFY_MESSAGES_RECEIVED == 0 {
		t.Fatal("notification type must not use 0")
	}
}

func TestFrameRejectsZeroType(t *testing.T) {
	if _, err := EncodeFrame(FrameCodecProtobuf, 1, 0, nil); err == nil {
		t.Fatal("expected type=0 to be rejected")
	}
}

func TestFrameHeaderIncludesMagicReservedCodecAndChecksum(t *testing.T) {
	pingType, ok := ActionType(appmsg.ActionPing)
	if !ok {
		t.Fatal("missing ping interface id")
	}

	data, err := EncodeFrame(FrameCodecProtobuf, 7, pingType, []byte("ping"))
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}
	if data[frameMagicOffset] != FrameMagic {
		t.Fatalf("magic=0x%02x, want 0x%02x", data[frameMagicOffset], FrameMagic)
	}
	if data[frameCodecOffset] != encodeFrameCodec(FrameEndianBig) {
		t.Fatalf("codec=0x%02x, want protobuf big-endian version 1", data[frameCodecOffset])
	}
	if data[frameReservedOffset] != FrameReserved {
		t.Fatalf("reserved=0x%02x, want 0x%02x", data[frameReservedOffset], FrameReserved)
	}
	if data[frameChecksumOffset] == 0 {
		t.Fatal("checksum must be filled")
	}

	frame, err := DecodeFrame(data)
	if err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if frame.Codec != FrameCodecProtobuf || frame.Endian != FrameEndianBig || frame.RequestID != 7 || frame.Type != pingType || string(frame.Body) != "ping" {
		t.Fatalf("decoded frame = %+v", frame)
	}
}

func TestFrameSupportsLittleEndianCodecBit(t *testing.T) {
	pingType, ok := ActionType(appmsg.ActionPing)
	if !ok {
		t.Fatal("missing ping interface id")
	}

	data, err := EncodeFrameWithEndian(FrameCodecProtobuf, FrameEndianLittle, 7, pingType, []byte("ping"))
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}
	if data[frameCodecOffset] != encodeFrameCodec(FrameEndianLittle) {
		t.Fatalf("codec=0x%02x, want protobuf little-endian version 1", data[frameCodecOffset])
	}

	frame, err := DecodeFrame(data)
	if err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if frame.Codec != FrameCodecProtobuf || frame.Endian != FrameEndianLittle || frame.RequestID != 7 || frame.Type != pingType {
		t.Fatalf("decoded frame = %+v", frame)
	}
}

func TestFrameRejectsBadMagicReservedCodecAndChecksum(t *testing.T) {
	pingType, ok := ActionType(appmsg.ActionPing)
	if !ok {
		t.Fatal("missing ping interface id")
	}
	data, err := EncodeFrame(FrameCodecProtobuf, 1, pingType, []byte("ping"))
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}

	badMagic := append([]byte(nil), data...)
	badMagic[frameMagicOffset] = 0
	if _, err := DecodeFrame(badMagic); err == nil || !strings.Contains(err.Error(), "invalid frame magic") {
		t.Fatalf("decode bad magic err=%v", err)
	}

	badReservedByte := append([]byte(nil), data...)
	badReservedByte[frameReservedOffset] = 1
	if _, err := DecodeFrame(badReservedByte); err == nil || !strings.Contains(err.Error(), "invalid frame reserved byte") {
		t.Fatalf("decode bad reserved byte err=%v", err)
	}

	badCodecVersion := append([]byte(nil), data...)
	badCodecVersion[frameCodecOffset] = 2 << frameCodecVersionShift
	badCodecVersion[frameChecksumOffset] = checksumFrame(badCodecVersion)
	if _, err := DecodeFrame(badCodecVersion); err == nil || !strings.Contains(err.Error(), "unsupported frame codec version") {
		t.Fatalf("decode bad codec version err=%v", err)
	}

	badCodecReservedBits := append([]byte(nil), data...)
	badCodecReservedBits[frameCodecOffset] |= 0x20
	badCodecReservedBits[frameChecksumOffset] = checksumFrame(badCodecReservedBits)
	if _, err := DecodeFrame(badCodecReservedBits); err == nil || !strings.Contains(err.Error(), "invalid frame codec reserved bits") {
		t.Fatalf("decode bad codec reserved bits err=%v", err)
	}

	badChecksum := append([]byte(nil), data...)
	badChecksum[len(badChecksum)-1] ^= 0xff
	if _, err := DecodeFrame(badChecksum); err == nil || !strings.Contains(err.Error(), "invalid frame checksum") {
		t.Fatalf("decode bad checksum err=%v", err)
	}
}
