import { describe, it, expect } from 'vitest';
import {
  renderMarkdownSafe,
  validateMessageLength,
  validateMarkdownLength,
  MAX_MARKDOWN_CHARS,
} from '../../../src/sdk/internal/message_ext';
import { messageSearchText } from '../../../src/sdk/internal/message-search';

describe('message body helpers', () => {
  it('render markdown safely', () => {
    const html = renderMarkdownSafe('**b** <script>x</script> `c`');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<code>c</code>');
  });

  it('reject too long plain message', () => {
    expect(() => validateMessageLength('a'.repeat(4097))).toThrow('4096');
  });

  it('reject too long markdown message', () => {
    expect(() => validateMarkdownLength('x'.repeat(MAX_MARKDOWN_CHARS + 1))).toThrow();
  });

  it('derives search text from strongly-typed body', () => {
    expect(messageSearchText({ text: { text: 'hello world' } })).toBe('hello world');
    expect(messageSearchText({ markdown: { markdown: '# title' } })).toBe('# title');
    expect(messageSearchText({ quote: { quote_msg_id: '1', quote_preview: 'orig', text: { text: 'reply' } } })).toBe('orig reply');
    expect(messageSearchText({ file: { media_id: '9', name: 'report.pdf' } })).toBe('report.pdf');
    expect(messageSearchText({ image: { media_id: '9', caption: 'sunset' } })).toBe('sunset');
    expect(messageSearchText({ image: { media_id: '9' } })).toBe('');
    expect(messageSearchText({ forward: { msg_ids: ['1'], title: 'chat log' } })).toBe('chat log');
    expect(messageSearchText({ recall: { msg_id: '1', operator_uid: '2', recall_time: 3, text: '撤回' } })).toBe('');
  });
});
