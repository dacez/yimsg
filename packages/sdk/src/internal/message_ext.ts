import { ValidationError } from '../errors';

// 结构化消息已全部改为强类型 protobuf MessageBody，不再使用 JSON / EXT 信封。
// 本模块仅保留文本长度校验与 Markdown 安全渲染等通用工具。

const MAX_MESSAGE_CHARS = 4096;
export const MAX_MARKDOWN_CHARS = 20000;

export function validateMessageLength(text: string): void {
  if ([...text].length > MAX_MESSAGE_CHARS) {
    throw new ValidationError(`消息不能超过 ${MAX_MESSAGE_CHARS} 个字符`);
  }
}

export function validateMarkdownLength(markdown: string): void {
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    throw new ValidationError(`Markdown 消息不能超过 ${MAX_MARKDOWN_CHARS} 字节`);
  }
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderMarkdownSafe(text: string): string {
  return escapeHtmlText(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
