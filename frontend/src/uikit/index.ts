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
export type { MountOptions, MountHandle, MountTarget, WidgetOn, WidgetEvents, UIKitMode } from './embed';
export type { ThemeOption, ThemePreset, ThemeTokens } from './theme';
export type { LocaleOption, LocaleCode, Messages } from './i18n';
export { YimsgClient } from '../sdk';

// 主应用入口不从这里导出：项目自身的 `main.ts` 直接从 `./uikit/app` 引入 `mountApp`。
// `mount()` 与 `mountApp()` 共享同一套完整 UIKit 视图，仅挂载宿主（Shadow DOM / Light DOM）不同。
