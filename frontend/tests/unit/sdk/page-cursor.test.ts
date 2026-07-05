import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  encodeSeqCursor,
  decodeSeqCursor,
} from "../../../src/sdk/internal/page-cursor";

// 展示通道不透明 keyset 游标 codec：与服务端 internal/service/page.go 的
// base64url("1" + 0x1f + parts...) 方案保持一致，保证 memory（服务端编码）与
// persistent（本地编码）两种模式下游标可互相解码、可在切换模式时透传。

describe("page-cursor codec", () => {
  it("encodeSeqCursor 已知向量与服务端一致", () => {
    // "1" \x1f "5" => bytes [0x31,0x1f,0x35] => base64url "MR81"（无填充）。
    expect(encodeSeqCursor(5)).toBe("MR81");
  });

  it("seq 游标 round-trip", () => {
    for (const seq of [0, 1, 42, 9007199254740991]) {
      expect(decodeSeqCursor(encodeSeqCursor(seq))).toBe(seq);
    }
  });

  it("空游标解码为空/0", () => {
    expect(decodeCursor("")).toEqual([]);
    expect(decodeSeqCursor("")).toBe(0);
  });

  it("多字段游标 round-trip（联系人 sort_key 含中文/分隔符安全）", () => {
    const parts = ["张三 Bob", "200", "0"];
    expect(decodeCursor(encodeCursor(...parts))).toEqual(parts);
  });

  it("版本不匹配的游标被拒绝", () => {
    // "Mh81" = base64url("2" + 0x1f + "5")，版本 2 ≠ 当前版本 1，必须拒绝。
    expect(() => decodeCursor("Mh81")).toThrow();
  });
});
