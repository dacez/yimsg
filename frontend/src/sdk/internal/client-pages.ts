import type {
  BlocklistUser as RawBlocklistUser,
  Contact as RawContact,
  Tag as RawTag,
  GroupMember as RawGroupMember,
  LocalConversation as RawLocalConversation,
  Message as RawMessage,
  MutelistEntry as RawMutelistEntry,
} from "../../types";
import type {
  BlocklistUserPage,
  ContactPage,
  TagsPage,
  ConversationPage,
  GroupMemberPage,
  MessagePage,
  MutelistEntryPage,
  PageInfo,
  SentMessage,
} from "../types";
import type { PageInfoResult } from "./action-mappers";
import { freezeArray, freezeObject } from "./readonly";
import {
  mapBlocklistUser,
  mapContact,
  mapTag,
  mapGroupMember,
  mapLocalConversation,
  mapMessage,
  mapMutelistEntry,
} from "./model-mappers";
import { normalizeRecallEvents } from "./client-event-bridge";

function freezePageInfo(page: PageInfoResult | undefined): PageInfo {
  return freezeObject({
    startCursor: page?.startCursor ?? "",
    endCursor: page?.endCursor ?? "",
    hasMoreBackward: Boolean(page?.hasMoreBackward),
    hasMoreForward: Boolean(page?.hasMoreForward),
    total: page?.total ?? -1,
  });
}

export function wrapMessagePage(result: {
  messages: RawMessage[];
  page: PageInfoResult;
}): MessagePage {
  return freezeObject({
    messages: freezeArray(normalizeRecallEvents(result.messages).map(mapMessage)),
    page: freezePageInfo(result.page),
  });
}

export function wrapConversationPage(page: {
  conversations: RawLocalConversation[];
  page: PageInfoResult;
}): ConversationPage {
  return freezeObject({
    conversations: freezeArray(page.conversations.map(mapLocalConversation)),
    page: freezePageInfo(page.page),
  });
}

export function wrapContactPage(page: {
  contacts: RawContact[];
  page: PageInfoResult;
}): ContactPage {
  return freezeObject({
    contacts: freezeArray(page.contacts.map(mapContact)),
    page: freezePageInfo(page.page),
  });
}

export function wrapTagsPage(page: {
  tags: RawTag[];
  page: PageInfoResult;
}): TagsPage {
  return freezeObject({
    tags: freezeArray(page.tags.map(mapTag)),
    page: freezePageInfo(page.page),
  });
}

export function wrapBlocklistUserPage(page: {
  users: RawBlocklistUser[];
  page: PageInfoResult;
}): BlocklistUserPage {
  return freezeObject({
    users: freezeArray(page.users.map(mapBlocklistUser)),
    page: freezePageInfo(page.page),
  });
}

export function wrapMutelistEntryPage(page: {
  mutes: RawMutelistEntry[];
  page: PageInfoResult;
}): MutelistEntryPage {
  return freezeObject({
    mutes: freezeArray(page.mutes.map(mapMutelistEntry)),
    page: freezePageInfo(page.page),
  });
}

export function wrapGroupMemberPage(page: {
  total: number;
  members: RawGroupMember[];
  page: PageInfoResult;
}): GroupMemberPage {
  return freezeObject({
    members: freezeArray(page.members.map(mapGroupMember)),
    page: freezePageInfo(page.page),
    total: page.total,
  });
}

export function wrapSentMessage(input: {
  seq: number;
  messageId: string;
  rawMessage: RawMessage;
}): SentMessage {
  return freezeObject({
    seq: input.seq,
    messageId: input.messageId,
    message: mapMessage(input.rawMessage),
  });
}
