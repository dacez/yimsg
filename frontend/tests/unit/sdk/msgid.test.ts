/**
 * msg_id 生成器单测。
 *
 * 校验 generateMsgId() 产出的 msg_id 是合法的 UUIDv7 base64url（无填充）表示：
 *   - 固定长度 22 字符、base64url 字母表；
 *   - 使用安全随机源 crypto.getRandomValues，绝不使用 Math.random；
 *   - 可无损解码回 16 字节，version/variant 位正确；
 *   - 前 48 位毫秒时间戳随时间递增；
 *   - isValidMsgId 正确接受合法值、拒绝各类非法值。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateMsgId,
  isValidMsgId,
  MSG_ID_LENGTH,
} from "../../../src/sdk/internal/msgid";

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 测试内部用的 base64url 无填充解码，独立于被测实现。 */
function decodeBase64Url(id: string): Uint8Array {
  const out = new Uint8Array(16);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < id.length; i++) {
    const v = B64URL.indexOf(id[i]);
    if (v < 0) throw new Error(`非法 base64url 字符: ${id[i]}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** 测试内部用的 base64url 无填充编码，独立于被测实现。 */
function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64URL[b2 & 0x3f];
  }
  return out;
}

/** 取前 48 位（6 字节）big-endian 毫秒时间戳。 */
function timestampMs(bytes: Uint8Array): number {
  return (
    bytes[0] * 2 ** 40 +
    bytes[1] * 2 ** 32 +
    bytes[2] * 2 ** 24 +
    bytes[3] * 2 ** 16 +
    bytes[4] * 2 ** 8 +
    bytes[5]
  );
}

describe("generateMsgId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("返回长度固定 22 且 isValidMsgId 通过", () => {
    const id = generateMsgId();
    expect(MSG_ID_LENGTH).toBe(22);
    expect(id).toHaveLength(22);
    expect(isValidMsgId(id)).toBe(true);
  });

  it("只使用 base64url 字母表字符", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateMsgId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("使用 crypto.getRandomValues 而非 Math.random", () => {
    const randomSpy = vi.spyOn(globalThis.Math, "random");
    const cryptoSpy = vi.spyOn(globalThis.crypto, "getRandomValues");

    generateMsgId();

    expect(randomSpy).not.toHaveBeenCalled();
    expect(cryptoSpy).toHaveBeenCalled();
  });

  it("可无损序列化 / 反序列化（解码 16 字节后再编码得到同一字符串）", () => {
    const id = generateMsgId();
    const raw = decodeBase64Url(id);
    expect(raw).toHaveLength(16);
    expect(encodeBase64Url(raw)).toBe(id);
  });

  it("解码后是合法 UUIDv7：version=7、variant=0b10", () => {
    for (let i = 0; i < 50; i++) {
      const raw = decodeBase64Url(generateMsgId());
      expect(raw[6] & 0xf0).toBe(0x70); // version 7
      expect(raw[8] & 0xc0).toBe(0x80); // variant 0b10
    }
  });

  it("前 48 位时间戳随时间递增（假时钟推进）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T00:00:00.000Z"));
    const first = decodeBase64Url(generateMsgId());

    vi.setSystemTime(new Date("2026-05-31T00:00:05.000Z"));
    const second = decodeBase64Url(generateMsgId());

    expect(timestampMs(second)).toBeGreaterThan(timestampMs(first));
    expect(timestampMs(first)).toBe(Date.parse("2026-05-31T00:00:00.000Z"));
  });
});

describe("isValidMsgId", () => {
  it("接受真实生成的 msg_id", () => {
    expect(isValidMsgId(generateMsgId())).toBe(true);
  });

  it("拒绝长度不对的字符串", () => {
    expect(isValidMsgId("")).toBe(false);
    expect(isValidMsgId("AAAA")).toBe(false);
    expect(isValidMsgId(generateMsgId() + "A")).toBe(false);
  });

  it("拒绝含非法字符的字符串", () => {
    const id = generateMsgId();
    // 把首字符替换成 base64url 字母表外的 '*'，长度仍为 22。
    expect(isValidMsgId("*" + id.slice(1))).toBe(false);
  });

  it("拒绝 version / variant 位不正确的值", () => {
    const raw = decodeBase64Url(generateMsgId());

    const badVersion = raw.slice();
    badVersion[6] = (badVersion[6] & 0x0f) | 0x40; // version 4，非 7
    expect(isValidMsgId(encodeBase64Url(badVersion))).toBe(false);

    const badVariant = raw.slice();
    badVariant[8] = badVariant[8] & 0x3f; // variant 0b00，非 0b10
    expect(isValidMsgId(encodeBase64Url(badVariant))).toBe(false);
  });
});
