// Package wire 独立实现 CLI 侧的 WebSocket 二进制帧编解码，与 server/internal/ws
// 的实现镜像同一份协议（见 protocol/yimsg.proto 与 CLAUDE.md 项目不变量），但作为
// 一个独立客户端不依赖服务端 internal 包，做法与 TypeScript SDK
// （packages/sdk/src/transport/frame.ts）各自独立实现一致。
//
// 帧格式：magic:uint8('M') + codec:uint8(bitfield) + reserved:uint8(0) +
// checksum:uint8(CRC-8) + size:uint16 + request_id:uint64 + type:uint16 + body。
// codec 低位到高位：bit0 endian（0=big-endian，1=little-endian）、bit1-4 version（当前 1）、
// bit5-7 保留必须为 0。整包上限 0xffff 字节，header 16 字节，body 上限 65519 字节。
// checksum 按 checksum 字节置 0 后对整包计算 CRC-8（poly 0x07，init 0x00）。
package wire

import (
	"encoding/binary"
	"fmt"
)

type FrameCodec byte
type FrameEndian byte

const (
	FrameCodecProtobuf FrameCodec = 'b'

	FrameMagic                        = byte('M')
	FrameReserved                     = byte(0)
	FrameCodecVersion                 = byte(1)
	FrameEndianBig        FrameEndian = 0
	FrameEndianLittle     FrameEndian = 1
	FrameHeaderSize                   = 16
	MaxFramePacketSize                = 0xffff
	MaxFrameBodySize                  = MaxFramePacketSize - FrameHeaderSize
	NotificationRequestID             = uint64(0)

	frameMagicOffset     = 0
	frameCodecOffset     = 1
	frameReservedOffset  = 2
	frameChecksumOffset  = 3
	frameBodySizeOffset  = 4
	frameRequestIDOffset = 6
	frameTypeOffset      = 14

	frameCodecLittleEndianMask = byte(0x01)
	frameCodecVersionMask      = byte(0x1e)
	frameCodecReservedMask     = byte(0xe0)
	frameCodecVersionShift     = 1
)

// Frame 是解码后的一帧协议消息。
type Frame struct {
	Codec     FrameCodec
	Endian    FrameEndian
	RequestID uint64
	Type      uint16
	Body      []byte
}

// EncodeFrame 按大端序编码一帧；CLI 作为客户端固定使用大端序，与服务端默认一致。
func EncodeFrame(codec FrameCodec, requestID uint64, typeID uint16, body []byte) ([]byte, error) {
	if codec != FrameCodecProtobuf {
		return nil, fmt.Errorf("invalid frame codec: %q", byte(codec))
	}
	if typeID == 0 {
		return nil, fmt.Errorf("invalid frame type: 0")
	}
	if FrameHeaderSize+len(body) > MaxFramePacketSize {
		return nil, fmt.Errorf("frame packet too large: %d", FrameHeaderSize+len(body))
	}
	data := make([]byte, FrameHeaderSize+len(body))
	data[frameMagicOffset] = FrameMagic
	data[frameCodecOffset] = FrameCodecVersion << frameCodecVersionShift
	data[frameReservedOffset] = FrameReserved
	order := binary.BigEndian
	order.PutUint16(data[frameBodySizeOffset:frameRequestIDOffset], uint16(len(body)))
	order.PutUint64(data[frameRequestIDOffset:frameTypeOffset], requestID)
	order.PutUint16(data[frameTypeOffset:FrameHeaderSize], typeID)
	copy(data[FrameHeaderSize:], body)
	data[frameChecksumOffset] = checksumFrame(data)
	return data, nil
}

// DecodeFrame 解码一帧，支持服务端可能返回的大端或小端序。
func DecodeFrame(data []byte) (Frame, error) {
	if len(data) < FrameHeaderSize {
		return Frame{}, fmt.Errorf("frame too short")
	}
	if len(data) > MaxFramePacketSize {
		return Frame{}, fmt.Errorf("frame packet too large: %d", len(data))
	}
	if data[frameMagicOffset] != FrameMagic {
		return Frame{}, fmt.Errorf("invalid frame magic: 0x%02x", data[frameMagicOffset])
	}
	if data[frameReservedOffset] != FrameReserved {
		return Frame{}, fmt.Errorf("invalid frame reserved byte: 0x%02x", data[frameReservedOffset])
	}
	codec, endian, err := decodeFrameCodec(data[frameCodecOffset])
	if err != nil {
		return Frame{}, err
	}
	order := frameByteOrder(endian)
	size := int(order.Uint16(data[frameBodySizeOffset:frameRequestIDOffset]))
	if size > MaxFrameBodySize {
		return Frame{}, fmt.Errorf("frame body too large: %d", size)
	}
	if len(data) != FrameHeaderSize+size {
		return Frame{}, fmt.Errorf("frame size mismatch: header=%d actual=%d", size, len(data)-FrameHeaderSize)
	}
	if got, want := data[frameChecksumOffset], checksumFrame(data); got != want {
		return Frame{}, fmt.Errorf("invalid frame checksum: 0x%02x", got)
	}
	typeID := order.Uint16(data[frameTypeOffset:FrameHeaderSize])
	if typeID == 0 {
		return Frame{}, fmt.Errorf("invalid frame type: 0")
	}
	return Frame{
		Codec:     codec,
		Endian:    endian,
		RequestID: order.Uint64(data[frameRequestIDOffset:frameTypeOffset]),
		Type:      typeID,
		Body:      data[FrameHeaderSize:],
	}, nil
}

func decodeFrameCodec(value byte) (FrameCodec, FrameEndian, error) {
	version := (value & frameCodecVersionMask) >> frameCodecVersionShift
	if version != FrameCodecVersion {
		return 0, 0, fmt.Errorf("unsupported frame codec version: %d", version)
	}
	if value&frameCodecReservedMask != 0 {
		return 0, 0, fmt.Errorf("invalid frame codec reserved bits: 0x%02x", value&frameCodecReservedMask)
	}
	endian := FrameEndianBig
	if value&frameCodecLittleEndianMask != 0 {
		endian = FrameEndianLittle
	}
	return FrameCodecProtobuf, endian, nil
}

func frameByteOrder(endian FrameEndian) binary.ByteOrder {
	if endian == FrameEndianLittle {
		return binary.LittleEndian
	}
	return binary.BigEndian
}

func checksumFrame(data []byte) byte {
	var crc byte
	for i, value := range data {
		if i == frameChecksumOffset {
			value = 0
		}
		crc ^= value
		for bit := 0; bit < 8; bit++ {
			if crc&0x80 != 0 {
				crc = (crc << 1) ^ 0x07
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}
