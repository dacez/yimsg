/**
 * yimsg uikit — 可嵌入网页的完整 IM 组件，内部使用 Shadow DOM 进行样式隔离。
 *
 * 使用者分三层：
 *  1. ESM 嵌入：`import { mount } from '/uikit/yimsg-uikit.js'` 后挂载。
 *  2. 完整控制：通过返回的 `MountHandle` 或直接用 `YimsgClient` SDK 自定义 UI。
 *
 * 示例（一行代码）：
 *   mount('#chat', { serverUrl: 'https://im.example.com' });
 *
 * 第三方站点还可以完全不写 JavaScript：用普通 `<script src=... data-yimsg-auto>`
 * 加载 IIFE 产物，见 `auto-mount.ts`。
 */

export { mount } from './embed';
export type { MountOptions, MountHandle, MountTarget, WidgetOn, WidgetEvents, UIKitViewMode } from './embed';
export type { ThemeOption, ThemePreset, ThemeTokens } from './theme';
export type { LocaleOption, LocaleCode, Messages } from './i18n';
export { YimsgClient } from '@yimsg/sdk';

// 一行脚本自动挂载：模块加载即尝试执行，仅在 classic script 且声明 data-yimsg-auto
// 时生效；ESM 路径下 document.currentScript 为 null，这里静默跳过。
import { runAutoMount } from './auto-mount';
runAutoMount();

// 主应用入口通过 @yimsg/uikit/app 子路径导出，供官方 Web App 复用同一套视图。
// `mount()` 与 `mountApp()` 共享同一套完整 UIKit 视图，仅挂载宿主（Shadow DOM / Light DOM）不同。
