/**
 * 服务端地址解析：把单个 `serverUrl` 派生成 WebSocket、上传和媒体三个对外地址。
 *
 * yimsg 的目标集成形态是「部署到一台服务器，第三方站点跨域嵌入 UIKit」，宿主页
 * 与服务端天然不同源，因此 SDK 运行时不能依赖 `location` 推导地址，也不能把
 * `/media/...` 这类相对路径直接交给浏览器解析——那会指向宿主站点而不是服务端。
 *
 * 同源部署（不传 `serverUrl`）保持既有行为：WebSocket 从 `location` 推导，
 * 上传走 `/api/upload`，媒体保持相对路径。
 */

import { ValidationError } from "../errors";

/** 由 `serverUrl` 与显式覆盖项解析出的三个对外地址。 */
export interface ResolvedEndpoints {
  readonly wsUrl: string;
  readonly uploadUrl: string;
  /** 媒体基址；空串表示同源部署，媒体沿用相对路径。 */
  readonly mediaBaseUrl: string;
}

export interface EndpointOptions {
  readonly serverUrl?: string;
  readonly wsUrl?: string;
  readonly uploadUrl?: string;
}

/** 同源部署下的默认上传路径。 */
const DEFAULT_UPLOAD_PATH = "/api/upload";

/** 无 `location`（Node、Worker 等）时的兜底 WebSocket 地址。 */
const FALLBACK_WS_URL = "ws://localhost:8080/ws";

/**
 * 绝对地址判定：任何已经带 scheme 的地址都不再拼接基址。
 * 覆盖 `https://`、`blob:https://`（乐观发送的本地预览）和 `data:` 三类。
 * 服务端返回的媒体路径以 `/` 开头，不会误判。
 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 从 `location` 推导同源 WebSocket 地址。 */
function defaultWsUrl(): string {
  if (typeof location === "undefined") return FALLBACK_WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/**
 * 把 `serverUrl` 归一成 `{origin, basePath}`：
 * basePath 去掉末尾斜杠，便于与 `/ws`、`/api/upload` 直接拼接而不产生 `//`。
 */
function parseServerUrl(serverUrl: string): { origin: string; basePath: string } {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new ValidationError(
      "serverUrl 必须是带协议的完整地址，例如 https://im.example.com",
      { context: "ClientOptions", details: { serverUrl } },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError("serverUrl 只支持 http 或 https 协议", {
      context: "ClientOptions",
      details: { serverUrl },
    });
  }
  return {
    origin: parsed.origin,
    basePath: parsed.pathname.replace(/\/+$/, ""),
  };
}

/**
 * 解析三个对外地址。`wsUrl` / `uploadUrl` 显式传入时覆盖由 `serverUrl` 派生的值，
 * 便于 WebSocket 与 HTTP 走不同入口（例如各自独立的反向代理）。
 */
export function resolveEndpoints(options: EndpointOptions): ResolvedEndpoints {
  const serverUrl = options.serverUrl?.trim();
  if (!serverUrl) {
    return {
      wsUrl: options.wsUrl ?? defaultWsUrl(),
      uploadUrl: options.uploadUrl ?? DEFAULT_UPLOAD_PATH,
      mediaBaseUrl: "",
    };
  }

  const { origin, basePath } = parseServerUrl(serverUrl);
  const wsOrigin = origin.replace(/^http/, "ws");
  return {
    wsUrl: options.wsUrl ?? `${wsOrigin}${basePath}/ws`,
    uploadUrl: options.uploadUrl ?? `${origin}${basePath}${DEFAULT_UPLOAD_PATH}`,
    mediaBaseUrl: `${origin}${basePath}`,
  };
}

/**
 * 把服务端返回的媒体路径解析成可直接放进 `src` 的地址。
 *
 * 服务端始终返回 `/media/{category}/{id}` 这样的相对路径（部署地址可变，存绝对
 * 地址会让数据随迁移作废），因此跨域嵌入时必须由客户端补上服务端基址。
 */
export function resolveMediaUrl(path: string | null | undefined, mediaBaseUrl: string): string {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return "";
  // 已经是绝对地址（外部 CDN、data: 等）时原样返回，避免二次拼接。
  if (ABSOLUTE_URL_RE.test(trimmed)) return trimmed;
  if (!mediaBaseUrl) return trimmed;
  return trimmed.startsWith("/")
    ? `${mediaBaseUrl}${trimmed}`
    : `${mediaBaseUrl}/${trimmed}`;
}
