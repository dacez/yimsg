import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEndpoints, resolveMediaUrl } from "../../../src/internal/server-url";
import { YimsgClient } from "../../../src/client";

/**
 * 跨域嵌入的地址解析契约：宿主站点与服务端不同源时，三个对外地址必须全部由
 * serverUrl 派生，运行时不再依赖 location。
 */
describe("serverUrl 端点派生", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HTTPS 服务端派生出 wss 与绝对上传地址", () => {
    const endpoints = resolveEndpoints({ serverUrl: "https://im.example.com" });

    expect(endpoints.wsUrl).toBe("wss://im.example.com/ws");
    expect(endpoints.uploadUrl).toBe("https://im.example.com/api/upload");
    expect(endpoints.mediaBaseUrl).toBe("https://im.example.com");
  });

  it("HTTP 服务端派生出 ws", () => {
    const endpoints = resolveEndpoints({ serverUrl: "http://localhost:8080" });

    expect(endpoints.wsUrl).toBe("ws://localhost:8080/ws");
    expect(endpoints.uploadUrl).toBe("http://localhost:8080/api/upload");
  });

  it("带路径前缀的服务端保留前缀", () => {
    const endpoints = resolveEndpoints({ serverUrl: "https://im.example.com/yimsg" });

    expect(endpoints.wsUrl).toBe("wss://im.example.com/yimsg/ws");
    expect(endpoints.uploadUrl).toBe("https://im.example.com/yimsg/api/upload");
    expect(endpoints.mediaBaseUrl).toBe("https://im.example.com/yimsg");
  });

  it("末尾斜杠归一，不产生双斜杠", () => {
    const withSlash = resolveEndpoints({ serverUrl: "https://im.example.com/" });
    const withoutSlash = resolveEndpoints({ serverUrl: "https://im.example.com" });

    expect(withSlash).toEqual(withoutSlash);
    expect(withSlash.wsUrl).not.toContain("//ws");
  });

  it("显式 wsUrl 覆盖派生值，uploadUrl 仍由 serverUrl 派生", () => {
    const endpoints = resolveEndpoints({
      serverUrl: "https://im.example.com",
      wsUrl: "wss://gateway.example.com/socket",
    });

    expect(endpoints.wsUrl).toBe("wss://gateway.example.com/socket");
    expect(endpoints.uploadUrl).toBe("https://im.example.com/api/upload");
  });

  it("不传 serverUrl 时沿用同源默认：从 location 推导且媒体保持相对路径", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "app.example.com" });

    const endpoints = resolveEndpoints({});

    expect(endpoints.wsUrl).toBe("wss://app.example.com/ws");
    expect(endpoints.uploadUrl).toBe("/api/upload");
    expect(endpoints.mediaBaseUrl).toBe("");
  });

  it("非法 serverUrl 抛校验错误而不是静默回退", () => {
    expect(() => resolveEndpoints({ serverUrl: "not a url" })).toThrowError(
      /serverUrl/,
    );
  });

  it("非 http(s) 协议的 serverUrl 被拒绝", () => {
    expect(() => resolveEndpoints({ serverUrl: "ftp://im.example.com" })).toThrowError(
      /serverUrl/,
    );
  });
});

describe("媒体地址解析", () => {
  it("相对媒体路径补上服务端基址", () => {
    expect(resolveMediaUrl("/media/avatar/x", "https://im.example.com")).toBe(
      "https://im.example.com/media/avatar/x",
    );
  });

  it("带路径前缀的基址同样正确拼接", () => {
    expect(resolveMediaUrl("/media/image/x", "https://im.example.com/yimsg")).toBe(
      "https://im.example.com/yimsg/media/image/x",
    );
  });

  it("已是绝对地址时原样返回，不二次拼接", () => {
    expect(resolveMediaUrl("https://cdn.example.com/a.png", "https://im.example.com")).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("blob 与 data 预览地址原样返回", () => {
    expect(resolveMediaUrl("blob:https://host/abc", "https://im.example.com")).toBe(
      "blob:https://host/abc",
    );
    expect(resolveMediaUrl("data:image/png;base64,AA", "https://im.example.com")).toBe(
      "data:image/png;base64,AA",
    );
  });

  it("空值返回空串，交由调用方回落到首字母占位", () => {
    expect(resolveMediaUrl("", "https://im.example.com")).toBe("");
    expect(resolveMediaUrl(undefined, "https://im.example.com")).toBe("");
    expect(resolveMediaUrl(null, "https://im.example.com")).toBe("");
  });

  it("未配置 serverUrl 时保持相对路径（同源部署行为不变）", () => {
    expect(resolveMediaUrl("/media/avatar/x", "")).toBe("/media/avatar/x");
  });
});

describe("YimsgClient.resolveMediaUrl", () => {
  it("按构造时的 serverUrl 解析媒体地址", () => {
    const client = new YimsgClient({
      serverUrl: "https://im.example.com",
      wsFactory: () => ({ addEventListener() {}, close() {} }) as unknown as WebSocket,
    });

    expect(client.resolveMediaUrl("/media/image/abc")).toBe(
      "https://im.example.com/media/image/abc",
    );
  });

  it("同源部署（无 serverUrl）保持相对路径", () => {
    const client = new YimsgClient({
      wsUrl: "ws://127.0.0.1:8080/ws",
      wsFactory: () => ({ addEventListener() {}, close() {} }) as unknown as WebSocket,
    });

    expect(client.resolveMediaUrl("/media/image/abc")).toBe("/media/image/abc");
  });
});
