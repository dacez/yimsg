export type FrameCodec = 'b';

export interface Frame {
  readonly codec: FrameCodec;
  readonly littleEndian: boolean;
  readonly requestId: string;
  readonly typeId: number;
  readonly body: Uint8Array;
}

const FRAME_MAGIC = 'M'.charCodeAt(0);
const FRAME_RESERVED = 0;
const FRAME_CODEC_VERSION = 1;
const FRAME_HEADER_SIZE = 16;
const MAX_FRAME_PACKET_SIZE = 0xffff;
const MAX_FRAME_BODY_SIZE = MAX_FRAME_PACKET_SIZE - FRAME_HEADER_SIZE;
const FRAME_MAGIC_OFFSET = 0;
const FRAME_CODEC_OFFSET = 1;
const FRAME_RESERVED_OFFSET = 2;
const FRAME_CHECKSUM_OFFSET = 3;
const FRAME_BODY_SIZE_OFFSET = 4;
const FRAME_REQUEST_ID_OFFSET = 6;
const FRAME_TYPE_ID_OFFSET = 14;
const FRAME_CODEC_LITTLE_ENDIAN_MASK = 0x01;
const FRAME_CODEC_VERSION_MASK = 0x1e;
const FRAME_CODEC_RESERVED_MASK = 0xe0;
const FRAME_CODEC_VERSION_SHIFT = 1;
const textEncoder = new TextEncoder();

export function encodeFrame(codec: FrameCodec, requestId: string, typeId: number, body: Uint8Array): Uint8Array {
  return encodeFrameWithEndian(codec, false, requestId, typeId, body);
}

export function encodeFrameWithEndian(codec: FrameCodec, littleEndian: boolean, requestId: string, typeId: number, body: Uint8Array): Uint8Array {
  if (codec !== 'b') {
    throw new Error(`invalid frame codec: ${codec}`);
  }
  if (typeId === 0) {
    throw new Error('invalid frame interface id: 0');
  }
  if (FRAME_HEADER_SIZE + body.byteLength > MAX_FRAME_PACKET_SIZE) {
    throw new Error(`frame packet too large: ${FRAME_HEADER_SIZE + body.byteLength}`);
  }
  const frame = new Uint8Array(FRAME_HEADER_SIZE + body.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame[FRAME_MAGIC_OFFSET] = FRAME_MAGIC;
  frame[FRAME_CODEC_OFFSET] = encodeFrameCodec(littleEndian);
  frame[FRAME_RESERVED_OFFSET] = FRAME_RESERVED;
  view.setUint16(FRAME_BODY_SIZE_OFFSET, body.byteLength, littleEndian);
  view.setBigUint64(FRAME_REQUEST_ID_OFFSET, BigInt(requestId), littleEndian);
  view.setUint16(FRAME_TYPE_ID_OFFSET, typeId, littleEndian);
  frame.set(body, FRAME_HEADER_SIZE);
  frame[FRAME_CHECKSUM_OFFSET] = checksumFrame(frame);
  return frame;
}

export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < FRAME_HEADER_SIZE) {
    throw new Error('frame too short');
  }
  if (data.byteLength > MAX_FRAME_PACKET_SIZE) {
    throw new Error(`frame packet too large: ${data.byteLength}`);
  }
  if (data[FRAME_MAGIC_OFFSET] !== FRAME_MAGIC) {
    throw new Error(`invalid frame magic: 0x${data[FRAME_MAGIC_OFFSET].toString(16).padStart(2, '0')}`);
  }
  if (data[FRAME_RESERVED_OFFSET] !== FRAME_RESERVED) {
    throw new Error(`invalid frame reserved byte: 0x${data[FRAME_RESERVED_OFFSET].toString(16).padStart(2, '0')}`);
  }
  const codecByte = data[FRAME_CODEC_OFFSET];
  const { codec, littleEndian } = decodeFrameCodec(codecByte);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = view.getUint16(FRAME_BODY_SIZE_OFFSET, littleEndian);
  if (size > MAX_FRAME_BODY_SIZE) {
    throw new Error(`frame body too large: ${size}`);
  }
  if (data.byteLength !== FRAME_HEADER_SIZE + size) {
    throw new Error(`frame size mismatch: header=${size} actual=${data.byteLength - FRAME_HEADER_SIZE}`);
  }
  const checksum = checksumFrame(data);
  if (data[FRAME_CHECKSUM_OFFSET] !== checksum) {
    throw new Error(`invalid frame checksum: 0x${data[FRAME_CHECKSUM_OFFSET].toString(16).padStart(2, '0')}`);
  }
  const typeId = view.getUint16(FRAME_TYPE_ID_OFFSET, littleEndian);
  if (typeId === 0) {
    throw new Error('invalid frame interface id: 0');
  }
  return {
    codec,
    littleEndian,
    requestId: view.getBigUint64(FRAME_REQUEST_ID_OFFSET, littleEndian).toString(),
    typeId,
    body: data.subarray(FRAME_HEADER_SIZE),
  };
}

function encodeFrameCodec(littleEndian: boolean): number {
  let value = FRAME_CODEC_VERSION << FRAME_CODEC_VERSION_SHIFT;
  if (littleEndian) value |= FRAME_CODEC_LITTLE_ENDIAN_MASK;
  return value;
}

function decodeFrameCodec(value: number): { codec: FrameCodec; littleEndian: boolean } {
  const version = (value & FRAME_CODEC_VERSION_MASK) >> FRAME_CODEC_VERSION_SHIFT;
  if (version !== FRAME_CODEC_VERSION) {
    throw new Error(`unsupported frame codec version: ${version}`);
  }
  if ((value & FRAME_CODEC_RESERVED_MASK) !== 0) {
    throw new Error(`invalid frame codec reserved bits: 0x${(value & FRAME_CODEC_RESERVED_MASK).toString(16).padStart(2, '0')}`);
  }
  return {
    codec: 'b',
    littleEndian: (value & FRAME_CODEC_LITTLE_ENDIAN_MASK) !== 0,
  };
}

function checksumFrame(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.byteLength; i++) {
    let value = data[i];
    if (i === FRAME_CHECKSUM_OFFSET) value = 0;
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export async function websocketDataToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === 'string') {
    return textEncoder.encode(data);
  }
  throw new Error('unsupported websocket message data');
}
