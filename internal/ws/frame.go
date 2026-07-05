package ws

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

type Frame struct {
	Codec     FrameCodec
	Endian    FrameEndian
	RequestID uint64
	Type      uint16
	Body      []byte
}

func EncodeFrame(codec FrameCodec, requestID uint64, typeID uint16, body []byte) ([]byte, error) {
	return EncodeFrameWithEndian(codec, FrameEndianBig, requestID, typeID, body)
}

func EncodeFrameWithEndian(codec FrameCodec, endian FrameEndian, requestID uint64, typeID uint16, body []byte) ([]byte, error) {
	if codec != FrameCodecProtobuf {
		return nil, fmt.Errorf("invalid frame codec: %q", byte(codec))
	}
	if endian != FrameEndianBig && endian != FrameEndianLittle {
		return nil, fmt.Errorf("invalid frame endian: %d", endian)
	}
	if typeID == 0 {
		return nil, fmt.Errorf("invalid frame type: 0")
	}
	if FrameHeaderSize+len(body) > MaxFramePacketSize {
		return nil, fmt.Errorf("frame packet too large: %d", FrameHeaderSize+len(body))
	}
	data := make([]byte, FrameHeaderSize+len(body))
	data[frameMagicOffset] = FrameMagic
	data[frameCodecOffset] = encodeFrameCodec(endian)
	data[frameReservedOffset] = FrameReserved
	order := frameByteOrder(endian)
	order.PutUint16(data[frameBodySizeOffset:frameRequestIDOffset], uint16(len(body)))
	order.PutUint64(data[frameRequestIDOffset:frameTypeOffset], requestID)
	order.PutUint16(data[frameTypeOffset:FrameHeaderSize], typeID)
	copy(data[FrameHeaderSize:], body)
	data[frameChecksumOffset] = checksumFrame(data)
	return data, nil
}

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

func encodeFrameCodec(endian FrameEndian) byte {
	value := FrameCodecVersion << frameCodecVersionShift
	if endian == FrameEndianLittle {
		value |= frameCodecLittleEndianMask
	}
	return value
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
