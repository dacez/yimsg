/**
 * 运行环境判定。
 *
 * SDK 同时服务浏览器和本地客户端：浏览器端没有 SQLite 持久化后端，判定放在这里
 * 是为了让调用方在**动态 import 之前**就短路掉 Node 专用实现，避免浏览器白白
 * 下载一份永远不会执行的本地持久化代码。
 */
export function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}
