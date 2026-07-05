import { MSG_TYPE_QUOTE } from "../../constants";
import type { YimsgClient } from "../client";
import type {
  ConversationTarget,
  MessageBody,
  SendQuotedTextInput,
  SessionSnapshot,
} from "../types";

// @ts-expect-error convKey helper 已收敛到 YimsgClient 门面
type _HiddenParseConvKey = typeof import("./index").parseConvKey;

declare const client: YimsgClient;
declare const target: ConversationTarget;
declare const file: File;

// 结构化消息统一使用强类型 MessageBody。
const textBody: MessageBody = { text: { text: "hello" } };
client.sendMessage(target, textBody);
client.sendMessage(target, { quote: { quote_msg_id: "1", text: { text: "re" } } }, MSG_TYPE_QUOTE);
client.sendText(target, "hello");
client.sendMarkdown(target, "# hi");
client.sendImage(target, { mediaId: "9", caption: "cap" });
client.sendFile(target, { mediaId: "9", name: "a.pdf" });
client.updateUserInfo({ nickname: "Alice", avatarUrl: "/a.png" });
client.updateGroupInfo("group-1", { name: "研发群", avatarUrl: "/g.png" });
client.destroy();
client.validateTextMessage("hello");

const snapshot: SessionSnapshot = client.getSessionSnapshot();
void snapshot;

const conversation = client.describeConversation(target);
const conversationKey: string = conversation.key;
void conversationKey;

// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.sessionState;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.connectionState;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.isAuthenticated;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.isSessionInitialized;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.currentUid;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.mode;
// @ts-expect-error 生命周期快捷字段已移除，统一改为 getSessionSnapshot()
client.connected;

async function assertUploadResultShape() {
  const result = await client.uploadFile(file, "file");
  const url: string = result.url;
  void url;

  // @ts-expect-error UploadResult 不再暴露 ok
  result.ok;
}

void assertUploadResultShape;

async function assertPublicMessageShape() {
  const result = await client.sendText(target, "hello");
  await client.getMessages({ target, limit: 20 });
  const messageId: string = result.messageId;
  const senderId: string = result.message.senderId;
  void messageId;
  void senderId;

  const messageDetails = client.describeMessage(result.message);
  const previewText: string = messageDetails.text;
  void previewText;

  // 公开消息使用强类型 body，不再暴露 content。
  const replyText: string = result.message.body.text?.text ?? "";
  void replyText;

  const messageConversation = client.describeMessageConversation(result.message);
  const messageConversationKey: string = messageConversation.key;
  void messageConversationKey;

  const quoteInput: SendQuotedTextInput = {
    text: "reply",
    quoteMsgId: result.messageId,
    quotePreview: "hello",
  };
  await client.sendQuotedTextMessage(target, quoteInput);
  await client.forwardMessages(target, [result.message], "转发");
  await client.recallMessage(result.message);

  // @ts-expect-error 公开消息不再暴露 snake_case 字段
  result.message.msg_id;
  // @ts-expect-error 发送结果不再暴露历史字段 msgId
  result.msgId;
  // @ts-expect-error 公开消息不再暴露 content 字段
  result.message.content;
}

void assertPublicMessageShape;

async function assertPublicPageApiNames() {
  await client.getMessages({ target, limit: 20 });
  await client.getMessages({ target, backward: true, limit: 20 });
  await client.getConversations({ cursor: "", limit: 20 });
  await client.getContacts({ cursor: "", limit: 20 });
  await client.getBlocklist({ cursor: "", limit: 20 });
  await client.getMutelist({ cursor: "", limit: 20 });
  await client.blockUser("100");
  await client.unblockUser("100");
  const unreadCount: number = await client.getUnreadCount();
  void unreadCount;
  await client.getGroupMembers("group-1", { cursor: "", limit: 20 });
  await client.favoriteGroup("group-1");
  await client.unfavoriteGroup("group-1");
  await client.muteConversation(target);
  await client.unmuteConversation(target);
  client.getUserInfos(["100"]);
  client.getGroupInfos(["group-1"]);
}

void assertPublicPageApiNames;

client.on("messages:received", (event) => {
  // @ts-expect-error 事件对象为只读
  event.messages = [];
  // @ts-expect-error 事件对象字段为只读
  event.messages[0].body = {};
});

// @ts-expect-error connect 已内化为私有实现，不再对外暴露
client.connect();
// @ts-expect-error disconnect 已收敛到 logout 内部，不再对外暴露
client.disconnect();
// @ts-expect-error 旧 snake_case 会话接口已删除，请使用 getConversations
client.get_conversations({ offset: 0, limit: 20 });
// @ts-expect-error 旧 snake_case 联系人接口已删除，请使用 getContacts
client.get_contacts({ offset: 0, limit: 20 });
// @ts-expect-error 旧 snake_case 消息接口已删除，请使用 getMessages
client.get_messages({ target, limit: 20 });
// @ts-expect-error 旧 snake_case 屏蔽列表接口已删除，请使用 getBlocklist
client.get_blocklist({ offset: 0, limit: 20 });
// @ts-expect-error 旧 snake_case 免打扰接口已删除，请使用 getMutelist
client.get_mutelist({ offset: 0, limit: 20 });
// @ts-expect-error 旧 snake_case 未读总数接口已删除，请使用 getUnreadCount
client.get_unread_count();
// @ts-expect-error 旧 snake_case 群成员接口已删除，请使用 getGroupMembers
client.get_group_members("group-1", { offset: 0, limit: 20 });
// @ts-expect-error 旧 snake_case 用户信息接口已删除，请使用 getUserInfos
client.get_user_infos(["100"]);
// @ts-expect-error 旧 snake_case 群信息接口已删除，请使用 getGroupInfos
client.get_group_infos(["group-1"]);
// @ts-expect-error 群成员全量数组接口已删除，请使用 getGroupMembers
client.listGroupMembers("group-1");
// @ts-expect-error 消息分页接口已统一命名为 getMessages
client.listMessages({ target });
// @ts-expect-error 屏蔽列表分页接口已统一命名为 getBlocklist
client.listBlocklist();
// @ts-expect-error 免打扰分页接口已统一命名为 getMutelist
client.listMute();
// @ts-expect-error 用户信息接口已删除，请使用 getUserInfos
client.readProfile();
// @ts-expect-error updateUserInfo 仅接受 avatarUrl
client.updateUserInfo({ avatar: "/legacy.png" });
// @ts-expect-error updateGroupInfo 仅接受 avatarUrl
client.updateGroupInfo("group-1", { avatar: "/legacy-group.png" });
