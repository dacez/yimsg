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

function renderInlineSafe(line: string): string {
  return line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

// 仅支持 1-4 级标题（行首 # ~ #### + 空格），其余文本按原有粗体/代码/换行规则渲染。
export function renderMarkdownSafe(text: string): string {
  const lines = escapeHtmlText(text).split('\n');
  const parts: string[] = [];
  lines.forEach((line, index) => {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      parts.push(`<h${level}>${renderInlineSafe(heading[2])}</h${level}>`);
      return;
    }
    const prevIsHeading = index > 0 && /^#{1,4}\s+/.test(lines[index - 1] ?? '');
    if (index > 0 && !prevIsHeading) {
      parts.push('<br>');
    }
    parts.push(renderInlineSafe(line));
  });
  return parts.join('');
}
