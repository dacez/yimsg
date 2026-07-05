import { describe, expect, it } from 'vitest';
import { MSG_TYPE_TEXT } from '../../src/constants';
import type { AppInstance } from '../../src/uikit/app/app-instance';

function makeApp(overrides: Partial<AppInstance> = {}): AppInstance {
  const zhMap: Record<string, string> = {
    'chat.forwardPreviewTruncated': '仅预览前 {shown} 条，共 {total} 条转发消息',
    'chat.forwardBlockSummary': '已转发 {n} 条（点击查看）',
    'chat.previewImage': '[图片]',
    'chat.previewFile': '[文件]',
  };
  const enMap: Record<string, string> = {
    'chat.forwardPreviewTruncated': 'Showing first {shown} of {total} forwarded messages',
    'chat.forwardBlockSummary': 'Forwarded {n} items (click to view)',
    'chat.previewImage': '[Image]',
    'chat.previewFile': '[File]',
  };
  const locale = (overrides.getLang?.() ?? 'zh') as 'zh' | 'en';
  const dict = locale === 'en' ? enMap : zhMap;
  return {
    t: (key: string, vars?: Record<string, string | number>) => {
      let text = dict[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
    getLang: () => locale,
    client: {
      describeMessage: () => ({ text: 'ext', html: '' }),
      getSessionSnapshot: () => ({ currentUid: '100' }),
      getClientConfig: () => ({ recallWindowsSeconds: 3, batchMaxLimit: 500 }),
      get_group_infos: () => new Map(),
      get_user_infos: () => new Map(),
      describeConversation: (value: unknown) => value as never,
    } as unknown as AppInstance['client'],
    ...overrides,
  } as AppInstance;
}

describe('chat helpers', () => {
  it('formats forward block text through i18n', async () => {
    const { formatForwardBlockText } = await import('../../src/uikit/app/views/chat/helpers');
    expect(formatForwardBlockText(makeApp({ getLang: () => 'en' } as Partial<AppInstance>), 3)).toBe('Forwarded 3 items (click to view)');
  });

  it('uses server recall time limit to decide whether recall is allowed', async () => {
    const { canRecallMessage } = await import('../../src/uikit/app/views/chat/helpers');
    expect(canRecallMessage(makeApp(), {
      seq: 1,
      messageId: 'm1',
      senderId: '100',
      recipientId: '200',
      groupId: '0',
      messageType: MSG_TYPE_TEXT,
      body: { text: { text: 'hello' } },
      sentAt: Date.now() - 4_000,
    })).toBe(false);
  });

});
