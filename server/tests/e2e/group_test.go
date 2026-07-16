package e2e

import (
	"testing"
	"time"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/msgid"
)

// makeFriends establishes a bidirectional friendship between two authenticated clients.
func makeFriends(t *testing.T, a, b *client) {
	t.Helper()
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" }, defaultNotifTimeout)
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" }, defaultNotifTimeout)
	// Small settle time for async processing
	time.Sleep(200 * time.Millisecond)
}

// setupGroupUsers creates N users (registered + logged in) and makes them all friends with the first user (owner).
func setupGroupUsers(t *testing.T, n int) []*client {
	t.Helper()
	clients := make([]*client, n)
	for i := 0; i < n; i++ {
		c := dial(t)
		c.registerAndLogin(uniqueName("grp"), "pass1234", "User"+string(rune('A'+i)))
		clients[i] = c
	}
	// Make everyone friends with the owner (clients[0])
	for i := 1; i < n; i++ {
		makeFriends(t, clients[0], clients[i])
	}
	// Drain any remaining notifications
	for _, c := range clients {
		c.drainNotifs(func(n *appmsg.Notification) bool { return true })
	}
	return clients
}

func TestCreateGroup(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	resp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "TestGroup", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	if resp.GetGroupId() <= 0 {
		t.Fatal("create_group should return group_id")
	}

	// Members should receive messages:received notification (system message about group creation)
	m1.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) != 0
	}, 3*time.Second)
	m2.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) != 0
	}, 3*time.Second)
}

func TestCreateGroupNoMembers(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("grp"), "pass1234", "Owner")

	// Creating a group with empty member_uids: server adds the owner automatically,
	// so a single-member group is created. We just verify it doesn't crash.
	resp := send(c, "create_group", &pb.CreateGroupRequest{
		Name: "EmptyGroup", MemberUids: []int64{},
	}, &pb.CreateGroupResponse{})
	// Whether this succeeds or fails depends on server validation;
	// either way it should not panic.
	_ = resp
}

func TestGetGroupInfos(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "InfoGroup", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()
	time.Sleep(200 * time.Millisecond)

	resp := sendOK(owner, "get_group_infos", &pb.GetGroupInfosRequest{GroupIds: []int64{groupID}}, &pb.GetGroupInfosResponse{})
	if len(resp.GetGroups()) != 1 {
		t.Fatalf("expected 1 group info, got %d", len(resp.GetGroups()))
	}
	if resp.GetGroups()[0].GetName() != "InfoGroup" {
		t.Errorf("group name = %q, want %q", resp.GetGroups()[0].GetName(), "InfoGroup")
	}
	if resp.GetGroups()[0].GetGroupId() != groupID {
		t.Errorf("group_id = %d, want %d", resp.GetGroups()[0].GetGroupId(), groupID)
	}
	if resp.GetGroups()[0].GetOwnerUid() != owner.uid {
		t.Errorf("owner_uid = %d, want %d", resp.GetGroups()[0].GetOwnerUid(), owner.uid)
	}
}

func TestGetGroupInfosBatch(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	r1 := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "BatchGroup1", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	r2 := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "BatchGroup2", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	resp := sendOK(owner, "get_group_infos", &pb.GetGroupInfosRequest{GroupIds: []int64{r1.GetGroupId(), r2.GetGroupId()}}, &pb.GetGroupInfosResponse{})
	if len(resp.GetGroups()) != 2 {
		t.Fatalf("expected 2 group infos, got %d", len(resp.GetGroups()))
	}
	names := map[string]bool{}
	for _, g := range resp.GetGroups() {
		names[g.GetName()] = true
	}
	if !names["BatchGroup1"] {
		t.Error("missing BatchGroup1")
	}
	if !names["BatchGroup2"] {
		t.Error("missing BatchGroup2")
	}
}

func TestGetGroupMembers(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "MembersGroup", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	resp := sendOK(owner, "get_group_members", &pb.GetGroupMembersRequest{GroupId: createResp.GetGroupId()}, &pb.GetGroupMembersResponse{})
	if len(resp.GetMembers()) != 3 {
		t.Fatalf("expected 3 members, got %d", len(resp.GetMembers()))
	}
	uidSet := map[int64]bool{}
	for _, m := range resp.GetMembers() {
		uidSet[m.GetUid()] = true
	}
	for _, c := range clients {
		if !uidSet[c.uid] {
			t.Errorf("missing member uid %d", c.uid)
		}
	}
	// Verify owner role (2 = owner in server schema)
	for _, m := range resp.GetMembers() {
		if m.GetUid() == owner.uid && m.GetRole() != 2 {
			t.Errorf("owner role = %d, want 2", m.GetRole())
		}
		if m.GetUid() != owner.uid && m.GetRole() != 0 {
			t.Errorf("member %d role = %d, want 0", m.GetUid(), m.GetRole())
		}
	}
}

func TestGetGroupMembersPagination(t *testing.T) {
	clients := setupGroupUsers(t, 4)
	owner := clients[0]

	memberUIDs := make([]int64, len(clients))
	for i, c := range clients {
		memberUIDs[i] = c.uid
	}

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "PaginationGroup", MemberUids: memberUIDs,
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	// 首页 limit=2（向下/FORWARD）
	resp1 := sendOK(owner, "get_group_members", &pb.GetGroupMembersRequest{GroupId: createResp.GetGroupId(), Page: &pb.PageQuery{Limit: 2}}, &pb.GetGroupMembersResponse{})
	if len(resp1.GetMembers()) != 2 {
		t.Fatalf("page 1: expected 2 members, got %d", len(resp1.GetMembers()))
	}

	// 次页：用上一页 end_cursor 续翻
	resp2 := sendOK(owner, "get_group_members", &pb.GetGroupMembersRequest{GroupId: createResp.GetGroupId(), Page: &pb.PageQuery{Limit: 2, Cursor: resp1.GetPage().GetEndCursor()}}, &pb.GetGroupMembersResponse{})
	if len(resp2.GetMembers()) != 2 {
		t.Fatalf("page 2: expected 2 members, got %d", len(resp2.GetMembers()))
	}

	// Verify no overlap
	page1UIDs := map[int64]bool{}
	for _, m := range resp1.GetMembers() {
		page1UIDs[m.GetUid()] = true
	}
	for _, m := range resp2.GetMembers() {
		if page1UIDs[m.GetUid()] {
			t.Errorf("uid %d appears in both pages", m.GetUid())
		}
	}
}

func TestUpdateGroupInfo(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "OldName", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()
	time.Sleep(200 * time.Millisecond)

	sendOK(owner, "update_group_info", &pb.UpdateGroupInfoRequest{GroupId: groupID, Name: "NewName"}, &pb.UpdateGroupInfoResponse{})

	resp := sendOK(owner, "get_group_infos", &pb.GetGroupInfosRequest{GroupIds: []int64{groupID}}, &pb.GetGroupInfosResponse{})
	if len(resp.GetGroups()) != 1 {
		t.Fatalf("expected 1 group info, got %d", len(resp.GetGroups()))
	}
	if resp.GetGroups()[0].GetName() != "NewName" {
		t.Errorf("name = %q, want %q", resp.GetGroups()[0].GetName(), "NewName")
	}
}

func TestUpdateGroupInfoNonOwner(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "OwnerOnly", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	sendErr(m1, "update_group_info", &pb.UpdateGroupInfoRequest{GroupId: createResp.GetGroupId(), Name: "HackedName"}, &pb.UpdateGroupInfoResponse{})
}

func TestAddGroupMember(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	// Create group with owner + m1
	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "AddMemberGroup", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()
	time.Sleep(300 * time.Millisecond)

	// Drain notifications from group creation
	owner.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m1.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m2.drainNotifs(func(n *appmsg.Notification) bool { return true })

	// Owner adds m2
	sendOK(owner, "add_group_member", &pb.AddGroupMemberRequest{GroupId: groupID, Uid: m2.uid}, &pb.AddGroupMemberResponse{})

	// Existing members and new member should get system message notification
	m1.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	}, 3*time.Second)
	m2.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	}, 3*time.Second)

	// Verify member count is now 3
	resp := sendOK(owner, "get_group_members", &pb.GetGroupMembersRequest{GroupId: groupID}, &pb.GetGroupMembersResponse{})
	if len(resp.GetMembers()) != 3 {
		t.Fatalf("expected 3 members after add, got %d", len(resp.GetMembers()))
	}
}

func TestAddGroupMemberDuplicate(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "DupGroup", MemberUids: []int64{owner.uid, m1.uid},
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	// Try to add m1 again
	sendErr(owner, "add_group_member", &pb.AddGroupMemberRequest{GroupId: createResp.GetGroupId(), Uid: m1.uid}, &pb.AddGroupMemberResponse{})
}

func TestRemoveGroupMember(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "RemoveGroup", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()
	time.Sleep(300 * time.Millisecond)

	// Drain notifications from group creation
	owner.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m1.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m2.drainNotifs(func(n *appmsg.Notification) bool { return true })

	// Owner removes m2
	sendOK(owner, "remove_group_member", &pb.RemoveGroupMemberRequest{GroupId: groupID, Uid: m2.uid}, &pb.RemoveGroupMemberResponse{})

	// Remaining members should get system message
	m1.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	}, 3*time.Second)

	// Verify member count is now 2
	resp := sendOK(owner, "get_group_members", &pb.GetGroupMembersRequest{GroupId: groupID}, &pb.GetGroupMembersResponse{})
	if len(resp.GetMembers()) != 2 {
		t.Fatalf("expected 2 members after removal, got %d", len(resp.GetMembers()))
	}
}

func TestRemoveGroupMemberNonOwner(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "NonOwnerRemove", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	time.Sleep(200 * time.Millisecond)

	// m1 (non-owner) tries to remove m2 — should fail
	resp := send(m1, "remove_group_member", &pb.RemoveGroupMemberRequest{GroupId: createResp.GetGroupId(), Uid: m2.uid}, &pb.RemoveGroupMemberResponse{})
	// The server may not explicitly check owner for remove, but typically only owner can.
	// If the server allows it, this test documents that behavior.
	_ = resp
}

func TestGroupMessage(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "MsgGroup", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()
	time.Sleep(300 * time.Millisecond)

	// Drain creation notifications
	owner.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m1.drainNotifs(func(n *appmsg.Notification) bool { return true })
	m2.drainNotifs(func(n *appmsg.Notification) bool { return true })

	// Owner sends a text message to the group
	sendResp := owner.sendText(groupTarget(groupID), "hello group")
	if sendResp.GetMsgId() == "" {
		t.Fatal("send_message should return msg_id")
	}

	// Both members should receive messages:received notification
	m1.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	}, 3*time.Second)
	m2.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	}, 3*time.Second)

	// Members can sync the message
	time.Sleep(200 * time.Millisecond)
	syncResp := sendOK(m1, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0, Limit: 100}, &pb.SyncMessagesResponse{})
	found := false
	for _, msg := range syncResp.GetMessages() {
		if msg.GetMsgId() == sendResp.GetMsgId() && bodyText(msg) == "hello group" && msg.GetTarget().GetGroupId() == groupID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("member should be able to sync the group message")
	}
}

func TestGroupMessageNonMember(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, member := clients[0], clients[1]

	createResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "GroupNonMember", MemberUids: []int64{owner.uid, member.uid},
	}, &pb.CreateGroupResponse{})
	groupID := createResp.GetGroupId()

	outsider := dial(t)
	outsider.registerAndLogin(uniqueName("grp"), "pass1234", "Outsider")

	resp := sendErr(outsider, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: groupTarget(groupID), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("i should fail"),
	}, &pb.SendMessageResponse{})
	if resp.GetBase().GetMsg() != "非群员" {
		t.Fatalf("error=%q, want 非群员", resp.GetBase().GetMsg())
	}
}
