/**
 * 启动首选项判定。
 *
 * 浏览器端只有内存模式，不再需要让用户在「即时 / 持久」之间选择；首次访问
 * （尚无 token）仍然先确认布局偏好。
 */

/** 首次访问、还没有任何登录态时需要先确认布局偏好。 */
export function needsInitialLayoutSelection(token: string | null): boolean {
  return !token;
}
