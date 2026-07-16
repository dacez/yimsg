/**
 * yimsg uikit — 可嵌入网页的完整 IM 组件，内部使用 Shadow DOM 进行样式隔离。
 *
 * 使用者分三层：
 *  1. ESM 嵌入：`import { mount } from '/uikit/yimsg-uikit.js'` 后挂载。
 *  2. 完整控制：通过返回的 `MountHandle` 或直接用 `YimsgClient` SDK 自定义 UI。
 *
 * 示例（一行代码）：
 *   mount('#chat', { wsUrl: '...', token: '...' });
 */

export { mount } from './embed';
export type { MountOptions, MountHandle, MountTarget, WidgetOn, WidgetEvents, UIKitMode, UIKitViewMode } from './embed';
export type { ThemeOption, ThemePreset, ThemeTokens } from './theme';
export type { LocaleOption, LocaleCode, Messages } from './i18n';
export { YimsgClient } from '@yimsg/sdk';

// 主应用入口通过 @yimsg/uikit/app 子路径导出，供官方 Web App 复用同一套视图。
// `mount()` 与 `mountApp()` 共享同一套完整 UIKit 视图，仅挂载宿主（Shadow DOM / Light DOM）不同。
