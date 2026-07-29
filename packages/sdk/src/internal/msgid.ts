// msg_id 的唯一生成点。msg_id 是 UUIDv7 的 base64url（无填充）编码，固定 22 字符。
//
// 业务约束（见 CLAUDE.md / docs）：
//   - 整个项目中 msg_id 永远是 string，禁止任何二进制 UUID 表示。
//   - 用户消息的 msg_id 只允许在此处（TypeScript SDK）生成。
//   - 服务端只做校验、保存、回传与幂等；缺失或非法直接拒绝请求。

/** msg_id 的固定字符串长度：16 字节经 base64url 无填充编码为 22 字符。 */
export const MSG_ID_LENGTH = 22;

const RAW_LEN = 16;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function secureCrypto(): Crypto {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("msgid: 安全随机源 crypto.getRandomValues 不可用");
  }
  return c;
}

function base64urlEncode(bytes: Uint8Array): string {
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

/** 生成一个新的 msg_id（UUIDv7 的 base64url 编码）。仅供 SDK 内部为用户消息生成。 */
export function generateMsgId(): string {
  const bytes = new Uint8Array(RAW_LEN);
  const ms = Date.now();
  // 48-bit 毫秒时间戳（big-endian）。
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  // 随机填充剩余 10 字节（使用安全随机源，不允许 Math.random）。
  secureCrypto().getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version = 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant = 0b10
  return base64urlEncode(bytes);
}
