# 接入客服-小林 私有知识库：开发者接入

## 怎么把客服组件嵌入到我自己的网站？
用 yimsg UIKit：`import * as YimsgUIKit from '/uikit/yimsg-uikit.js'`，然后调用 `YimsgUIKit.mount(容器节点, { wsUrl, uploadUrl, theme })` 即可挂载一个完整的聊天界面；支持 `chat-only` 等收窄模式，Shadow DOM 样式隔离，不会影响宿主页面。

## 有没有可以直接调用的 SDK 或 API？
有。除了开箱即用的 UIKit，还提供一套 UI 无关的 TypeScript SDK，可以基于 WebSocket 协议自己实现界面；HTTP 接口仅用于文件上传、静态资源与媒体访问，核心业务都走 WebSocket 二进制帧协议。

## 支持哪些主题和语言？
UIKit 支持浅色 / 深色 / 跟随系统主题，并且可以跟随宿主页面语言联动切换（多语言）。
