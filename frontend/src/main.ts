/**
 * main.ts — 浏览器入口：挂载 UIKit 的全量 持久存储 应用。
 *
 * 具体的装配逻辑位于 `src/uikit/app.ts` 与 `src/uikit/app/main-app.ts`，
 * 这里只做一个薄薄的入口转发，便于未来替换 host / 做多入口打包。
 */
import { mountApp } from './uikit/app';

mountApp();
