import {
  MSG_TYPE_FILE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_IMAGE,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_RECALL,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_TEXT,
} from '../constants';
import { renderMarkdownSafe, validateMessageLength } from './message_ext';
import { freezeObject } from './readonly';
import type {
  ImageBody,
  FileBody,
  Message,
  MessageContentDescriptor,
  RecallBody,
  ForwardAttachmentInfo,
  MessageQuoteInfo,
  MsgType,
} from '../types';

function descriptor(fields: {
  text: string;
  html?: string | null;
  bodyKind: MsgType;
  quote?: MessageQuoteInfo | null;
  forward?: ForwardAttachmentInfo | null;
  image?: ImageBody | null;
  file?: FileBody | null;
  recall?: RecallBody | null;
}): MessageContentDescriptor {
  return freezeObject({
    text: fields.text,
    html: fields.html ?? null,
    bodyKind: fields.bodyKind,
    quote: fields.quote ?? null,
    forward: fields.forward ?? null,
    image: fields.image ?? null,
    file: fields.file ?? null,
    recall: fields.recall ?? null,
  });
}

// describeMessageContent 从强类型 body 派生 UI 可读描述。body 才是真实展示来源。
export function describeMessageContent(message: Message): MessageContentDescriptor {
  const body = message.body || {};
  if (body.markdown) {
    return descriptor({ text: body.markdown.markdown, html: renderMarkdownSafe(body.markdown.markdown), bodyKind: MSG_TYPE_MARKDOWN });
  }
  if (body.text) {
    return descriptor({ text: body.text.text, bodyKind: MSG_TYPE_TEXT });
  }
  if (body.system) {
    return descriptor({ text: body.system.text, bodyKind: MSG_TYPE_SYSTEM });
  }
  if (body.image) {
    return descriptor({ text: body.image.caption || '', bodyKind: MSG_TYPE_IMAGE, image: body.image });
  }
  if (body.file) {
    return descriptor({ text: body.file.name, bodyKind: MSG_TYPE_FILE, file: body.file });
  }
  if (body.quote) {
    return descriptor({
      text: body.quote.text?.text || '',
      bodyKind: MSG_TYPE_QUOTE,
      quote: freezeObject({
        messageId: body.quote.quote_msg_id,
        preview: body.quote.quote_preview || '',
        text: body.quote.text?.text || '',
      }),
    });
  }
  if (body.forward) {
    return descriptor({
      text: body.forward.title || '',
      bodyKind: MSG_TYPE_FORWARD,
      forward: freezeObject({
        messageIds: [...(body.forward.msg_ids || [])],
        title: body.forward.title || '',
      }),
    });
  }
  if (body.recall) {
    return descriptor({ text: body.recall.text, bodyKind: MSG_TYPE_RECALL, recall: body.recall });
  }
  return descriptor({ text: '', bodyKind: message.messageType });
}

export function validateTextMessage(content: string): void {
  validateMessageLength(content);
}
