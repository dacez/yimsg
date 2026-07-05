import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrameWithEndian } from '../../../src/sdk/transport/frame';
import { LoginRequest, Type } from '../../../src/sdk/generated/yimsg';

interface GoldenFrameFixture {
  protobuf: {
    message: string;
    username: string;
    password: string;
    body_hex: string;
  };
  frames: Array<{
    name: string;
    little_endian: boolean;
    magic: number;
    codec: number;
    reserved: number;
    checksum: number;
    size: number;
    request_id: string;
    type: number;
    body_hex: string;
    frame_hex: string;
  }>;
}

function readFixture(): GoldenFrameFixture {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/protocol/golden_frames.json');
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenFrameFixture;
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('protocol golden frames', () => {
  it('Go / TypeScript 共享 LoginRequest frame 字节样例', () => {
    const fixture = readFixture();
    const body = LoginRequest.encode(LoginRequest.create({
      username: fixture.protobuf.username,
      password: fixture.protobuf.password,
    })).finish();

    expect(fixture.protobuf.message).toBe('LoginRequest');
    expect(toHex(body)).toBe(fixture.protobuf.body_hex);

    for (const sample of fixture.frames) {
      const frameBytes = fromHex(sample.frame_hex);
      expect(frameBytes[0]).toBe(sample.magic);
      expect(frameBytes[1]).toBe(sample.codec);
      expect(frameBytes[2]).toBe(sample.reserved);
      expect(frameBytes[3]).toBe(sample.checksum);

      const encoded = encodeFrameWithEndian('b', sample.little_endian, sample.request_id, Type.TYPE_ACTION_LOGIN, body);
      expect(toHex(encoded)).toBe(sample.frame_hex);

      const frame = decodeFrame(frameBytes);
      expect(frame.littleEndian).toBe(sample.little_endian);
      expect(frame.requestId).toBe(sample.request_id);
      expect(frame.typeId).toBe(sample.type);
      expect(frame.body.byteLength).toBe(sample.size);
      expect(toHex(frame.body)).toBe(sample.body_hex);

      const decoded = LoginRequest.decode(frame.body);
      expect(decoded.username).toBe(fixture.protobuf.username);
      expect(decoded.password).toBe(fixture.protobuf.password);
    }
  });
});
