import { describe, expect, it } from 'vitest';
import type { AppInstance } from '../../src/app/app-instance';
import {
  isNearBottom,
  scrollToBottom,
  stickToBottomAfterContentGrew,
} from '../../src/app/views/chat/message-list';

// 回归用例：图片消息发送后不会像文字消息一样自动跳到最新消息。
// 根因是 setup.ts 里图片 load 事件的兜底贴底判断，曾经在 load 触发时现算
// isNearBottom——但那一刻图片早已把消息列表撑高了（.message-image 没有预留
// 尺寸，加载完可以再长高到 320px），用发送时刻的旧 scrollTop 对比撑高后的新
// scrollHeight，必然因为增高超过 50px 贴底阈值而误判成"已经不贴底"，于是不会
// 把视图摁回底部。修复方案是贴底状态只由真实滚动事件持续跟踪
// （messageListStickToBottom），图片 load 时只读这个缓存标记，不现算。

interface FakeElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

// scrollTop 按真实浏览器的语义夹到 [0, scrollHeight-clientHeight]：直接赋值超出范围的值
// （如 scrollTop = scrollHeight）会被自动收敛到可滚动上限，而不是原样存成一个不可能达到
// 的越界数字——如果不夹这个范围，"贴底"就不再是一个真实可达的状态，测试会掩盖问题。
function createList(scrollHeight: number, clientHeight: number): FakeElement {
  let top = 0;
  const list = {
    get scrollTop() { return top; },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, Math.max(0, list.scrollHeight - list.clientHeight)));
    },
    scrollHeight,
    clientHeight,
  };
  return list;
}

function createApp(list: FakeElement): AppInstance {
  return {
    $: (id: string) => (id === 'message-list' ? (list as unknown as HTMLElement) : undefined),
    chatState: {
      messageListStickToBottom: true,
    },
  } as unknown as AppInstance;
}

describe('消息列表贴底状态跟踪（messageListStickToBottom）', () => {
  it('scrollToBottom 会把 scrollTop 摁到底部，并把贴底标记置为 true', () => {
    const list = createList(2000, 500);
    const app = createApp(list);
    app.chatState.messageListStickToBottom = false;

    scrollToBottom(app);

    expect(list.scrollTop).toBe(1500); // scrollHeight - clientHeight
    expect(app.chatState.messageListStickToBottom).toBe(true);
  });

  it('贴底标记为 true 时，内容异步增高（图片 load）后调用兜底函数会把 scrollTop 追到新的底部', () => {
    const list = createList(2000, 500);
    const app = createApp(list);
    scrollToBottom(app); // 发送时先贴底一次，模拟 uploadAndSend 里的 scrollToBottom(app)。
    expect(list.scrollTop).toBe(1500);

    // 图片在稍后才完成加载，把消息列表撑高（.message-image 没有预留尺寸，能长到 320px）。
    // 这个过程本身不产生 scroll 事件，只是 scrollHeight 变大，scrollTop 原地不动。
    list.scrollHeight += 280;
    expect(isNearBottom(list as unknown as HTMLElement)).toBe(false); // 撑高后离底部已经超过 50px 阈值。

    stickToBottomAfterContentGrew(app);

    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight); // 追到撑高后真正的底部。
    expect(isNearBottom(list as unknown as HTMLElement)).toBe(true);
  });

  it('用户已经上翻阅读历史（贴底标记为 false）时，图片撑高不应该把视图拽回底部', () => {
    const list = createList(3000, 500);
    list.scrollTop = 100; // 远离底部，正在看历史消息。
    const app = createApp(list);
    app.chatState.messageListStickToBottom = false;

    list.scrollHeight += 280; // 视口之外某张历史图片加载完成撑高了内容。
    stickToBottomAfterContentGrew(app);

    expect(list.scrollTop).toBe(100); // 阅读位置不受打扰。
  });

  it('贴底标记为 true 但内容其实没有增高时，兜底函数也是幂等的（不会把已经在底部的位置滚飞）', () => {
    const list = createList(2000, 500);
    const app = createApp(list);
    scrollToBottom(app);
    const before = list.scrollTop;

    stickToBottomAfterContentGrew(app);

    expect(list.scrollTop).toBe(before);
  });
});
