import type { MessageBody } from '../models';

// messageSearchText 生成消息搜索投影，与后端 internal/service/message_body.go 规则保持一致。
// search_text 是投影，不作为消息真实内容来源。
export function messageSearchText(body: MessageBody | undefined): string {
  if (!body) return '';
  if (body.text) return body.text.text || '';
  if (body.markdown) return body.markdown.markdown || '';
  if (body.quote) return `${body.quote.quote_preview || ''} ${body.quote.text?.text || ''}`.trim();
  if (body.file) return body.file.name || '';
  if (body.image) return body.image.caption || '';
  if (body.system) return body.system.text || '';
  if (body.forward) return body.forward.title || '';
  return '';
}
