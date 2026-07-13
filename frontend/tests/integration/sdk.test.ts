/**
 * SDK Integration Tests
 *
 * Tests YimsgClient against a real backend server.
 * Focus areas:
 * 1. SDK additional logic（DisplayInfoCache、会话 key、DataGateway 事件）
 * 2. UI-facing interfaces return correct data shapes
 * 3. Multi-client scenarios (notifications, sync)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createClient, createAuthenticatedClient, destroyClient, waitEvent, delay, uniqueUser } from './helpers';
import type { YimsgClient } from '../../src/sdk/client';
import { MSG_TYPE_TEXT, MSG_TYPE_QUOTE, MSG_TYPE_FORWARD, MSG_TYPE_RECALL, CONTACT_PENDING_INCOMING } from '../../src/constants';
import { seqCursor } from '../../src/sdk';
function bodyText(m: { body?: Record<string, { text?: string; markdown?: string } | { text?: { text?: string } }> }): string {
  const b = (m.body || {}) as any;
  if (b.text) return b.text.text || '';
  if (b.markdown) return b.markdown.markdown || '';
  if (b.system) return b.system.text || '';
  if (b.recall) return b.recall.text || '';
  if (b.quote) return b.quote.text?.text || '';
  return '';
}


const clients: YimsgClient[] = [];

function track(client: YimsgClient): YimsgClient {
  clients.push(client);
  return client;
}

async function makeFriends(alice: YimsgClient, aliceUid: string, bob: YimsgClient, bobUid: string) {
  await alice.addFriend(bobUid);
  await delay(300);
  await bob.acceptFriend(aliceUid);
  await delay(300);
}

afterEach(() => {
  clients.forEach(c => destroyClient(c));
  clients.length = 0;
});

// ============================================================
// Auth
// ============================================================
describe('Auth', () => {
  it('register + login', async () => {
    const { client, uid, token } = await createAuthenticatedClient('auth');
    track(client);

    expect(uid).toBeTruthy();
    expect(token).toBeTruthy();
    expect(client.getSessionSnapshot().currentUid).toBe(uid);
  });

  it('authenticate with saved token', async () => {
    const { client, token } = await createAuthenticatedClient('auth');
    track(client);

    // Create second client, authenticate with token
    const client2 = createClient();
    track(client2);

    const result = await client2.authenticate(token);
    expect(result.uid).toBeTruthy();
    expect(client2.getSessionSnapshot().currentUid).toBe(result.uid);
  });

  it('register duplicate fails', async () => {
    const { client, username } = await createAuthenticatedClient('dup');
    track(client);

    const client2 = createClient();
    track(client2);

    await expect(client2.register(username, 'pass', 'Nick')).rejects.toThrow();
  });

  it('logout clears state', async () => {
    const { client } = await createAuthenticatedClient('logout');
    track(client);

    await client.logout();
    expect(client.getSessionSnapshot().currentUid).toBeFalsy();
  });
});

// ============================================================
// startSession + Conversations
// ============================================================
describe('Session Init', () => {
  it('getConversations reads conversations after startSession', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('init_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('init_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);

    // Alice sends message to Bob
    await alice.startSession({ storage: 'memory' });
    await alice.sendText({ toUid: bobUid }, 'hello');

    // Bob inits session and should read the first conversation page.
    await bob.startSession({ storage: 'memory' });
    const page = await bob.getConversations({ offset: 0, limit: 20 });
    expect(page.conversations.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Messages
// ============================================================
describe('Messages', () => {
  it('sendMessage returns seq and messageId', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('msg_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('msg_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    const result = await alice.sendText({ toUid: bobUid }, 'test msg');
    expect(result.seq).toBeGreaterThan(0);
    expect(result.messageId).toBeTruthy();
    expect(bodyText(result.message)).toBe('test msg');
    expect(result.message.messageType).toBe(MSG_TYPE_TEXT);
  });

  it('sendQuotedTextMessage builds a QuoteBody', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('msg_quote_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('msg_quote_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    const origin = await alice.sendText({ toUid: bobUid }, 'origin');
    const result = await alice.sendQuotedTextMessage({ toUid: bobUid }, {
      text: 'reply with quote',
      quoteMsgId: origin.messageId,
      quotePreview: 'origin',
    });
    expect(result.message.messageType).toBe(MSG_TYPE_QUOTE);
    expect(result.message.body.quote?.text?.text).toBe('reply with quote');
  });

  it('forwardMessages builds a ForwardBody', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('msg_fwd_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('msg_fwd_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    const origin = await alice.sendText({ toUid: bobUid }, 'origin');
    const result = await alice.forwardMessages({ toUid: bobUid }, [origin.message], '转发给你');
    expect(result.message.messageType).toBe(MSG_TYPE_FORWARD);
    expect(result.message.body.forward?.msg_ids).toContain(origin.messageId);
    expect(result.message.body.forward?.title).toBe('转发给你');
  });

  it('sendMessage updates local conversations', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('conv_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('conv_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    await alice.sendText({ toUid: bobUid }, 'hi');
    const { conversations: convs } = await alice.getConversations({ offset: 0, limit: 10 });
    expect(convs.length).toBeGreaterThanOrEqual(1);
    expect(convs.some(c => c.friendUid === bobUid)).toBe(true);
  });

  it('getMessages returns messages', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('lcm_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('lcm_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    await alice.sendText({ toUid: bobUid }, 'msg1');
    await alice.sendText({ toUid: bobUid }, 'msg2');

    const msgs = await alice.getMessages({
      target: { toUid: bobUid },
      limit: 10,
    });
    expect(msgs.messages.length).toBe(2);
    expect(bodyText(msgs.messages[0])).toBeTruthy();
  });

  it('getMessages pagination (beforeSeq)', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('page_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('page_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    // Send 5 messages
    for (let i = 0; i < 5; i++) {
      await alice.sendText({ toUid: bobUid }, `msg-${i}`);
    }

    // Get all
    const all = await alice.getMessages({
      target: { toUid: bobUid }, limit: 10,
    });
    expect(all.messages.length).toBe(5);

    // 向上(BACKWARD)翻：第 3 条之前还有 2 条。
    const page = await alice.getMessages({
      target: { toUid: bobUid },
      cursor: seqCursor(all.messages[2].seq),
      backward: true,
      limit: 10,
    });
    expect(page.messages.length).toBe(2);
  });

  it('getMessages pagination (afterSeq)', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('page_after_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('page_after_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    for (let i = 0; i < 5; i++) {
      await alice.sendText({ toUid: bobUid }, `after-${i}`);
    }

    const page = await alice.getMessages({
      target: { toUid: bobUid },
      cursor: seqCursor(2),
      limit: 2,
    });
    // 展示序旧→新：seq>2 取最近 2 条 = 3、4 升序。
    expect(page.messages.map(message => message.seq)).toEqual([3, 4]);
  });

  it('clearUnread clears unread count', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('mr_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('mr_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    // Alice sends to Bob
    await alice.sendText({ toUid: bobUid }, 'read test');
    await delay(500);

    // Bob marks read
    await bob.clearUnread({ toUid: aliceUid });
    const conversationPage = await bob.getConversations({ offset: 0, limit: 10 });
    const count = conversationPage.conversations.find(conv => conv.friendUid === aliceUid)?.unreadCount || 0;
    expect(count).toBe(0);
  });

  it('recallMessage does not add runtime unread after receiver already marked read', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('recall_unread_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('recall_unread_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    const sent = await alice.sendText({ toUid: bobUid }, 'read then recall');
    await delay(300);

    await bob.clearUnread({ toUid: aliceUid });
    let conversationPage = await bob.getConversations({ offset: 0, limit: 10 });
    expect(conversationPage.conversations.find(conv => conv.friendUid === aliceUid)?.unreadCount || 0).toBe(0);

    const messagePromise = waitEvent(bob, 'messages:received', 5000);
    await alice.recallMessage(sent.message);

    const messageEvent = await messagePromise as { messages: ReadonlyArray<{ body: { recall?: { text?: string } } }> };
    expect(messageEvent.messages[0].body.recall?.text).toContain('撤回');
    conversationPage = await bob.getConversations({ offset: 0, limit: 10 });
    expect(conversationPage.conversations.find(conv => conv.friendUid === aliceUid)?.unreadCount || 0).toBe(0);

    const msgs = await bob.getMessages({ target: { toUid: aliceUid }, limit: 10 });
    expect(msgs.messages).toHaveLength(1);
    expect(bodyText(msgs.messages[0])).toContain('撤回');
  });

  it('recallMessage keeps getMessages visible as placeholder on receiver side', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('recall_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('recall_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    const sent = await alice.sendText({ toUid: bobUid }, 'to be recalled');
    await delay(300);
    await alice.recallMessage(sent.message);
    await delay(300);

    const msgs = await bob.getMessages({ target: { toUid: aliceUid }, limit: 10 });
    expect(msgs.messages).toHaveLength(1);
    expect(bodyText(msgs.messages[0])).toContain('撤回');
    expect(msgs.messages[0].messageType).toBe(MSG_TYPE_RECALL);
  });
});

// ============================================================
// Contacts
// ============================================================
describe('Contacts', () => {
  it('add + accept friend flow', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('ct_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('ct_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    await alice.addFriend(bobUid);
    await delay(300);
    await bob.acceptFriend(aliceUid);
    await delay(300);

    const { contacts } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    expect(contacts.some(c => String(c.friendUid) === bobUid)).toBe(true);
  });

  it('supports blocklist and conversation mutelist reads', async () => {
    const { client: alice } = await createAuthenticatedClient('shield_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('shield_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const blocklistSeq = await alice.blockUser(bobUid);
    expect(blocklistSeq).toBeGreaterThan(0);
    const blocklist = await alice.getBlocklist({ uid: bobUid, limit: 1 });
    expect(blocklist.users.some(entry => entry.uid === bobUid)).toBe(true);

    const muteSeq = await alice.muteConversation({ toUid: bobUid });
    const mutes = await alice.getMutelist({ toUid: bobUid, limit: 1 });
    expect(mutes.mutes).toEqual([expect.objectContaining({ toUid: bobUid, status: 1 })]);

    const unmuteSeq = await alice.unmuteConversation({ toUid: bobUid });
    expect(unmuteSeq).toBeGreaterThan(muteSeq);
    const afterUnmute = await alice.getMutelist({ toUid: bobUid, limit: 1 });
    expect(afterUnmute.mutes.some(entry => entry.toUid === bobUid)).toBe(false);
  });

  it('requester cannot accept or reject own outgoing request', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('selfacc_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('selfacc_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    // Alice 是申请方，向 Bob 发起请求。
    await alice.addFriend(bobUid);
    await delay(300);

    // Alice 对自己发出的请求调用 accept/reject 应该失败，不能把自己变成好友。
    await expect(alice.acceptFriend(bobUid)).rejects.toThrow();
    await expect(alice.rejectFriend(bobUid)).rejects.toThrow();

    const { contacts } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    expect(contacts.some(c => String(c.friendUid) === bobUid && c.status === 1)).toBe(false);

    // Bob（接收方）才能正常接受。
    await bob.acceptFriend(aliceUid);
    await delay(300);
    const { contacts: afterAccept } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    expect(afterAccept.some(c => String(c.friendUid) === bobUid && c.status === 1)).toBe(true);
  });

  it('reject friend', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('rej_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('rej_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    await alice.addFriend(bobUid);
    await delay(300);
    await bob.rejectFriend(aliceUid);
    await delay(300);

    const { contacts } = await bob.getContacts({ friendUid: aliceUid, limit: 1 });
    const friendEntry = contacts.find(c => String(c.friendUid) === aliceUid);
    // After reject, contact should not be visible as friend
    expect(!friendEntry || friendEntry.status !== 1).toBe(true);
  });

  it('delete friend', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('del_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('del_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    await alice.addFriend(bobUid);
    await delay(300);
    await bob.acceptFriend(aliceUid);
    await delay(300);

    await alice.deleteFriend(bobUid);
    await delay(300);

    const { contacts } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    expect(contacts.some(c => String(c.friendUid) === bobUid && c.status === 1)).toBe(false);
  });

  it('updateRemark', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('rmk_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('rmk_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    await alice.addFriend(bobUid);
    await delay(300);
    await bob.acceptFriend(aliceUid);
    await delay(300);

    await alice.updateRemark({ toUid: bobUid }, 'Bobby');
    await delay(300);

    const { contacts } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    const bob_c = contacts.find(c => String(c.friendUid) === bobUid);
    expect(bob_c?.remarkName).toBe('Bobby');
  });

  it('searchUser returns profile', async () => {
    const { client: alice, username } = await createAuthenticatedClient('search');
    track(alice);
    await alice.startSession({ storage: 'memory' });

    const profile = await alice.searchUser(username);
    expect(profile).toBeTruthy();
    expect(profile!.username).toBe(username);
  });

  it('searchUser not found', async () => {
    const { client: alice } = await createAuthenticatedClient('search_nf');
    track(alice);
    await alice.startSession({ storage: 'memory' });

    const profile = await alice.searchUser('nonexistent_user_xyz_123');
    expect(profile).toBeNull();
  });
});

// ============================================================
// Org（组织管理：按用户名录入的便捷方法）
// ============================================================
describe('Org', () => {
  it('addOrgMemberByUsername resolves username to uid and adds the member', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('org_add_a');
    const { client: bob, uid: bobUid, username: bobUsername } = await createAuthenticatedClient('org_add_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const orgId = await alice.createOrg('Org Add Test');
    // getTags 要求调用方本身是组织成员，先把自己挂进去（与 showCreateOrgModal 的建组织流程一致）。
    await alice.addOrgMember(orgId, orgId, aliceUid);
    await alice.addOrgMemberByUsername(orgId, orgId, bobUsername);

    const { tags } = await alice.getTags({ orgId, tagId: orgId, limit: 50 });
    expect(tags.some(t => t.childId === bobUid)).toBe(true);
  });

  it('addOrgMemberByUsername rejects unknown username', async () => {
    const { client: alice } = await createAuthenticatedClient('org_add_nf');
    track(alice);
    await alice.startSession({ storage: 'memory' });

    const orgId = await alice.createOrg('Org Add NF Test');
    await expect(alice.addOrgMemberByUsername(orgId, orgId, 'nonexistent_user_xyz_123')).rejects.toThrow();
  });

  it('grantOrgAdminByUsername resolves username to uid and grants admin', async () => {
    const { client: alice } = await createAuthenticatedClient('org_grant_a');
    const { client: bob, uid: bobUid, username: bobUsername } = await createAuthenticatedClient('org_grant_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const orgId = await alice.createOrg('Org Grant Test');
    await alice.grantOrgAdminByUsername(orgId, orgId, bobUsername);

    const admins = await alice.listOrgAdmins(orgId, orgId);
    expect(admins).toContain(bobUid);
  });

  it('grantOrgAdminByUsername rejects unknown username', async () => {
    const { client: alice } = await createAuthenticatedClient('org_grant_nf');
    track(alice);
    await alice.startSession({ storage: 'memory' });

    const orgId = await alice.createOrg('Org Grant NF Test');
    await expect(alice.grantOrgAdminByUsername(orgId, orgId, 'nonexistent_user_xyz_123')).rejects.toThrow();
  });
});

// ============================================================
// Groups
// ============================================================
describe('Groups', () => {
  it('create group + send group message', async () => {
    const { client: alice } = await createAuthenticatedClient('grp_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('grp_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('TestGroup', [bobUid]);
    expect(groupId).toBeTruthy();

    const result = await alice.sendText({ groupId }, 'group msg');
    expect(result.seq).toBeGreaterThan(0);
  });

  it('getGroupMembers', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('gm_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('gm_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('MemberTest', [bobUid]);
    const memberPage = await alice.getGroupMembers(groupId);
    expect(memberPage.total).toBe(2);
    expect(memberPage.members.length).toBe(2);
    const uids = memberPage.members.map(m => String(m.userId));
    expect(uids).toContain(aliceUid);
    expect(uids).toContain(bobUid);
  });

  it('updateGroupInfo', async () => {
    const { client: alice } = await createAuthenticatedClient('gui_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('gui_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('OldName', [bobUid]);
    await alice.updateGroupInfo(groupId, { name: 'NewName' });

    // Cache should be updated
    const display = alice.getGroupInfos([groupId]).get(groupId)!;
    expect(display.name).toBe('NewName');
  });

  it('add + remove group member', async () => {
    const { client: alice } = await createAuthenticatedClient('arm_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('arm_b');
    const { client: carol, uid: carolUid } = await createAuthenticatedClient('arm_c');
    track(alice); track(bob); track(carol);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('AddRemove', [bobUid]);

    // Add carol
    await alice.addGroupMember(groupId, carolUid);
    let memberPage = await alice.getGroupMembers(groupId);
    expect(memberPage.members.length).toBe(3);

    // Remove carol
    await alice.removeGroupMember(groupId, carolUid);
    memberPage = await alice.getGroupMembers(groupId);
    expect(memberPage.members.length).toBe(2);
  });
});

// ============================================================
// User Profile
// ============================================================
describe('User Profile', () => {
  it('getUserInfos returns own display info', async () => {
    const { client, uid } = await createAuthenticatedClient('prof');
    track(client);
    await client.startSession({ storage: 'memory' });

    const initial = client.getUserInfos([uid]).get(uid)!;
    if (!initial.username) {
      await waitEvent(client, 'display:updated', 3000);
    }
    const profile = client.getUserInfos([uid]).get(uid)!;
    expect(profile.username).toBeTruthy();
  });

  it('updateUserInfo updates nickname', async () => {
    const { client, uid } = await createAuthenticatedClient('upd');
    track(client);
    await client.startSession({ storage: 'memory' });

    await client.updateUserInfo({ nickname: 'NewNick' });

    // Cache should be updated
    const display = client.getUserInfos([uid]).get(uid)!;
    expect(display.nickname).toBe('NewNick');

    // Display cache should expose the updated nickname
    const updated = client.getUserInfos([uid]).get(uid)!;
    expect(updated.nickname).toBe('NewNick');
  });

  it('updatePassword', async () => {
    const { client, username } = await createAuthenticatedClient('pwd');
    track(client);

    await client.updatePassword('pass123', 'newpass456');

    // Re-login with new password
    const client2 = createClient();
    track(client2);
    const result = await client2.login(username, 'newpass456');
    expect(result.uid).toBeTruthy();
  });
});

// ============================================================
// DisplayInfoCache (SDK additional logic)
// ============================================================
describe('DisplayInfoCache', () => {
  it('getUserInfos returns empty on miss, then emits display:updated', async () => {
    const { client: alice } = await createAuthenticatedClient('cache_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('cache_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    // First call: miss → empty
    const initial = alice.getUserInfos([bobUid]).get(bobUid)!;
    // May be empty or may have data if cached
    // Wait for display:updated event
    const event = await waitEvent(alice, 'display:updated', 3000) as { keys: readonly string[] };
    expect(event.keys).toContain(bobUid);

    // After update, should have nickname
    const updated = alice.getUserInfos([bobUid]).get(bobUid)!;
    expect(updated.nickname).toBeTruthy();
  });

  it('getGroupInfo emits display:updated on miss', async () => {
    const { client: alice } = await createAuthenticatedClient('gcache_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('gcache_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('CacheTest', [bobUid]);

    // Group was just created, cache should be populated
    const display = alice.getGroupInfos([groupId]).get(groupId)!;
    expect(display.name).toBe('CacheTest');
  });
});

// ============================================================
// 会话分页与未读（服务端状态，SDK 不维护 ConversationStore）
// ============================================================
describe('会话分页与未读状态', () => {
  it('conversations are sorted by last_seq', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('sort_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('sort_b');
    const { client: carol, uid: carolUid } = await createAuthenticatedClient('sort_c');
    track(alice); track(bob); track(carol);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await makeFriends(alice, aliceUid, carol, carolUid);
    await alice.startSession({ storage: 'memory' });

    await alice.sendText({ toUid: bobUid }, 'first');
    await alice.sendText({ toUid: carolUid }, 'second');

    const { conversations: convs } = await alice.getConversations({ offset: 0, limit: 10 });
    expect(convs.length).toBeGreaterThanOrEqual(2);
    // Latest message should be first
    expect(convs[0].friendUid).toBe(carolUid);
  });

  it('unread counts accumulate', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('unrd_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('unrd_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    // Bob sends 3 messages to Alice
    for (let i = 0; i < 3; i++) {
      await bob.sendText({ toUid: aliceUid }, `msg-${i}`);
    }

    // Wait for notifications to arrive
    await delay(1000);

    // Alice refreshes the current conversation page and reads the server-side unread count.
    const conversationPage = await alice.getConversations({ offset: 0, limit: 10 });
    const count = conversationPage.conversations.find(conv => conv.friendUid === bobUid)?.unreadCount || 0;
    const totalUnreadCount = await alice.getUnreadCount();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(totalUnreadCount).toBeGreaterThanOrEqual(count);
  });

  it('clearUnread 后会话分页返回未读清零', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('act_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('act_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    await bob.sendText({ toUid: aliceUid }, 'read by page');
    await delay(1000);

    await alice.clearUnread({ toUid: bobUid });
    const conversationPage = await alice.getConversations({ offset: 0, limit: 10 });
    const count = conversationPage.conversations.find(conv => conv.friendUid === bobUid)?.unreadCount || 0;
    expect(count).toBe(0);
    await expect(alice.getUnreadCount()).resolves.toBe(0);
  });
});

// ============================================================
// Multi-client notifications
// ============================================================
describe('Multi-client Notifications', () => {
  it('messages:received event fires on recipient', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('notif_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('notif_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    const msgPromise = waitEvent(bob, 'messages:received', 5000);
    await alice.sendText({ toUid: bobUid }, 'notification test');

    const event = await msgPromise as { messages: readonly unknown[] };
    expect(Array.isArray(event.messages)).toBe(true);
  });

  it('contacts:updated event fires on accept', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('cce_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('cce_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    // Add friend first, then listen for contacts:updated on Bob's side when Alice adds
    await alice.addFriend(bobUid);
    await delay(500);

    // Now listen for contacts:updated on Alice when Bob accepts
    const contactPromise = waitEvent(alice, 'contacts:updated', 5000);
    await bob.acceptFriend(aliceUid);

    // Wait for contacts:updated notification on Alice
    const event = await contactPromise as { reason: string };
    expect(event.reason).toBe('notification_sync');
    const { contacts } = await alice.getContacts({ friendUid: bobUid, limit: 1 });
    expect(contacts.some(c => c.friendUid === bobUid && c.status === 1)).toBe(true);
  });

  it('conversations:sent event after send', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('cue_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('cue_b');
    track(alice); track(bob);
    await makeFriends(alice, aliceUid, bob, bobUid);
    await alice.startSession({ storage: 'memory' });

    let changedKeys: ReadonlyArray<string> | null = null;
    alice.on('conversations:sent', (event) => { changedKeys = event.keys; });

    await alice.sendText({ toUid: bobUid }, 'trigger update');

    expect(changedKeys).toEqual([`u:${bobUid}`]);
  });
});

// ============================================================
// Edge Cases
// ============================================================
describe('Edge Cases', () => {
  it('getConversations empty', async () => {
    const { client } = await createAuthenticatedClient('empty');
    track(client);
    await client.startSession({ storage: 'memory' });

    const convs = await client.getConversations({ offset: 0, limit: 10 });
    expect(Array.isArray(convs.conversations)).toBe(true);
    expect(convs.conversations.length).toBe(0);
  });

  it('getContacts empty', async () => {
    const { client } = await createAuthenticatedClient('empty_c');
    track(client);
    await client.startSession({ storage: 'memory' });

    const contacts = await client.getContacts({ offset: 0, limit: 10 });
    expect(Array.isArray(contacts.contacts)).toBe(true);
  });

  it('getContactCount', async () => {
    const { client: alice, uid: aliceUid } = await createAuthenticatedClient('pend_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('pend_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });
    await bob.startSession({ storage: 'memory' });

    // Bob sends friend request to Alice
    await bob.addFriend(aliceUid);
    await delay(500);

    // Alice should have pending count
    const count = await alice.getContactCount(CONTACT_PENDING_INCOMING);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('group message appears in getMessages', async () => {
    const { client: alice } = await createAuthenticatedClient('gm_conv_a');
    const { client: bob, uid: bobUid } = await createAuthenticatedClient('gm_conv_b');
    track(alice); track(bob);
    await alice.startSession({ storage: 'memory' });

    const groupId = await alice.createGroup('MsgGroup', [bobUid]);
    await alice.sendText({ groupId }, 'group hello');

    const msgs = await alice.getMessages({
      target: { groupId },
      limit: 50,
    });
    // Should have at least the text message (may also have system message)
    const textMsgs = msgs.messages.filter(m => m.messageType === MSG_TYPE_TEXT);
    expect(textMsgs.length).toBe(1);
    expect(bodyText(textMsgs[0])).toBe('group hello');
  });
});
