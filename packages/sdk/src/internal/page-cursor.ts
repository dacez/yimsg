// 展示通道不透明 keyset 游标的 base64url(紧凑字符串) 编解码，与服务端方案一致。
// 仅持久模式本地分页使用：本地副本自产自销游标，UI 原样透传。

const CURSOR_VERSION = "1";
const SEP = "\u001f";

function toBase64Url(s: string): string {
  // 浏览器与 Node 都支持的 UTF-8 安全 base64url 编码。
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = (typeof btoa === "function" ? btoa(binary) : Buffer.from(s, "utf8").toString("base64"));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

/** 编码 keyset 字段为不透明游标；空字段返回空串（表示该方向到顶/到底）。 */
export function encodeCursor(...parts: string[]): string {
  if (parts.length === 0) return "";
  return toBase64Url([CURSOR_VERSION, ...parts].join(SEP));
}

/** 还原 encodeCursor 的字段；空串返回 []。非法游标抛错。 */
export function decodeCursor(cursor: string): string[] {
  if (!cursor) return [];
  const raw = fromBase64Url(cursor);
  const parts = raw.split(SEP);
  if (parts.length < 1 || parts[0] !== CURSOR_VERSION) {
    throw new Error("invalid cursor");
  }
  return parts.slice(1);
}

export function encodeSeqCursor(seq: number): string {
  return encodeCursor(String(seq));
}

export function decodeSeqCursor(cursor: string): number {
  const parts = decodeCursor(cursor);
  return parts.length > 0 ? Number(parts[0]) : 0;
}
