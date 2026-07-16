import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrameWithEndian } from '../../../src/transport/frame';
import { LoginRequest, Type } from '@yimsg/protocol';

// 以下常量是 Go / TypeScript 共享的 protobuf frame 字节样例（golden vector）。
// 两侧分别硬编码同一组数据（见 internal/ws/golden_frame_test.go），不再通过
// 共享 JSON fixture 文件中转；修改帧格式时需要同步更新两侧常量。
const GOLDEN_USERNAME = 'alice';
const GOLDEN_PASSWORD = 'pass';
const GOLDEN_BODY_HEX = '5205616c6963655a0470617373';

interface GoldenFrameCase {
  name: string;
  littleEndian: boolean;
  magic: number;
  codec: number;
  reserved: number;
  checksum: number;
  size: number;
  requestId: string;
  type: number;
  bodyHex: string;
  frameHex: string;
}

const GOLDEN_FRAME_CASES: GoldenFrameCase[] = [
  {
    name: 'login_request_big_endian',
    littleEndian: false,
    magic: 77,
    codec: 2,
    reserved: 0,
    checksum: 227,
    size: 13,
    requestId: '72623859790382856',
    type: 2,
    bodyHex: GOLDEN_BODY_HEX,
    frameHex: '4d0200e3000d010203040506070800025205616c6963655a0470617373',
  },
  {
    name: 'login_request_little_endian',
    littleEndian: true,
    magic: 77,
    codec: 3,
    reserved: 0,
    checksum: 48,
    size: 13,
    requestId: '72623859790382856',
    type: 2,
    bodyHex: GOLDEN_BODY_HEX,
    frameHex: '4d0300300d00080706050403020102005205616c6963655a0470617373',
  },
];

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('protocol golden frames', () => {
  it('Go / TypeScript 共享 LoginRequest frame 字节样例', () => {
    const body = LoginRequest.encode(LoginRequest.create({
      username: GOLDEN_USERNAME,
      password: GOLDEN_PASSWORD,
    })).finish();

    expect(toHex(body)).toBe(GOLDEN_BODY_HEX);

    for (const sample of GOLDEN_FRAME_CASES) {
      const frameBytes = fromHex(sample.frameHex);
      expect(frameBytes[0]).toBe(sample.magic);
      expect(frameBytes[1]).toBe(sample.codec);
      expect(frameBytes[2]).toBe(sample.reserved);
      expect(frameBytes[3]).toBe(sample.checksum);

      const encoded = encodeFrameWithEndian('b', sample.littleEndian, sample.requestId, Type.TYPE_ACTION_LOGIN, body);
      expect(toHex(encoded)).toBe(sample.frameHex);

      const frame = decodeFrame(frameBytes);
      expect(frame.littleEndian).toBe(sample.littleEndian);
      expect(frame.requestId).toBe(sample.requestId);
      expect(frame.typeId).toBe(sample.type);
      expect(frame.body.byteLength).toBe(sample.size);
      expect(toHex(frame.body)).toBe(sample.bodyHex);

      const decoded = LoginRequest.decode(frame.body);
      expect(decoded.username).toBe(GOLDEN_USERNAME);
      expect(decoded.password).toBe(GOLDEN_PASSWORD);
    }
  });
});
