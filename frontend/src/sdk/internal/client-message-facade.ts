import {
  MSG_TYPE_FILE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_IMAGE,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_TEXT,
} from '../../constants';
import type { MessageBody, MsgType } from '../../types';
import {
  describeConversation as buildConversationDescriptor,
  describeMessageConversation as buildMessageConversationDescriptor,
} from './conversation-descriptor';
import {
  describeMessageContent as buildMessageContentDescriptor,
  validateTextMessage as assertValidTextMessage,
} from './message-descriptor';
import { validateMarkdownLength, validateMessageLength } from './message_ext';
import { APP_CONFIG } from '../../app-config';
import type {
  ConversationDescriptor,
  ConversationTarget,
  LocalConversation as PublicLocalConversation,
  Message as PublicMessage,
  MessageContentDescriptor,
  SentMessage as PublicSentMessage,
  SendQuotedTextInput,
  SessionSnapshot,
  UploadResult,
  UserDisplayInfo,
} from '../types';

type SendMessageFn = (
  target: ConversationTarget,
  body: MessageBody,
  msgType?: MsgType,
) => Promise<PublicSentMessage>;

/** sendImage 入参：媒体只用 media_id 引用。 */
export interface SendImageInput {
  readonly mediaId: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly mime?: string;
  readonly caption?: string;
}

/** sendFile 入参：媒体只用 media_id 引用。 */
export interface SendFileInput {
  readonly mediaId: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

interface ClientMessageFacadeDeps {
  getSessionSnapshot: () => SessionSnapshot;
  getUserInfos: (uids: string[]) => ReadonlyMap<string, UserDisplayInfo>;
  uploadFile: (file: File, category: 'avatar' | 'image' | 'file') => Promise<UploadResult>;
  sendMessage: SendMessageFn;
}

export class ClientMessageFacade {
  constructor(private readonly deps: ClientMessageFacadeDeps) {}

  describeConversation(source: PublicLocalConversation | ConversationTarget | string): ConversationDescriptor {
    return buildConversationDescriptor(source);
  }

  describeMessageConversation(message: PublicMessage): ConversationDescriptor {
    return buildMessageConversationDescriptor(message, this.deps.getSessionSnapshot().currentUid);
  }

  describeMessage(message: PublicMessage): MessageContentDescriptor {
    return buildMessageContentDescriptor(message);
  }

  validateTextMessage(content: string): void {
    assertValidTextMessage(content);
  }

  sendText(target: ConversationTarget, text: string): Promise<PublicSentMessage> {
    validateMessageLength(text);
    return this.deps.sendMessage(target, { text: { text } }, MSG_TYPE_TEXT);
  }

  sendMarkdown(target: ConversationTarget, markdown: string): Promise<PublicSentMessage> {
    validateMarkdownLength(markdown);
    return this.deps.sendMessage(target, { markdown: { markdown } }, MSG_TYPE_MARKDOWN);
  }

  sendImage(target: ConversationTarget, input: SendImageInput): Promise<PublicSentMessage> {
    return this.deps.sendMessage(target, {
      image: {
        media_id: input.mediaId,
        size: input.size,
        width: input.width,
        height: input.height,
        mime: input.mime,
        caption: input.caption,
      },
    }, MSG_TYPE_IMAGE);
  }

  sendFile(target: ConversationTarget, input: SendFileInput): Promise<PublicSentMessage> {
    return this.deps.sendMessage(target, {
      file: {
        media_id: input.mediaId,
        name: input.name,
        size: input.size,
        mime: input.mime,
      },
    }, MSG_TYPE_FILE);
  }

  sendQuotedTextMessage(target: ConversationTarget, input: SendQuotedTextInput): Promise<PublicSentMessage> {
    validateMessageLength(input.text);
    return this.deps.sendMessage(target, {
      quote: {
        quote_msg_id: input.quoteMsgId,
        quote_preview: input.quotePreview || '',
        text: { text: input.text },
      },
    }, MSG_TYPE_QUOTE);
  }

  forwardMessages(
    target: ConversationTarget,
    messages: ReadonlyArray<PublicMessage>,
    title: string,
  ): Promise<PublicSentMessage> {
    const sourceMessages = messages.slice(0, APP_CONFIG.forward.maxItems);
    return this.deps.sendMessage(target, {
      forward: {
        msg_ids: sourceMessages.map((message) => message.messageId),
        title,
      },
    }, MSG_TYPE_FORWARD);
  }
}
