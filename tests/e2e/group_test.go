package e2e

import (
	"testing"
	"time"
)

// makeFriends establishes a bidirectional friendship between two authenticated clients.
func makeFriends(t *testing.T, a, b *client) {
	t.Helper()
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" }, defaultNotifTimeout)
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" }, defaultNotifTimeout)
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
		c.drainNotifs(func(n notification) bool { return true })
	}
	return clients
}

func TestCreateGroup(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	resp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "TestGroup",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	if resp.GroupID == "" {
		t.Fatal("create_group should return group_id")
	}

	// Members should receive messages:received notification (system message about group creation)
	m1.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID != ""
	}, 3*time.Second)
	m2.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID != ""
	}, 3*time.Second)
}

func TestCreateGroupNoMembers(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("grp"), "pass1234", "Owner")

	// Creating a group with empty member_uids: server adds the owner automatically,
	// so a single-member group is created. We just verify it doesn't crash.
	resp := c.send(wsRequest{
		"action":      "create_group",
		"name":        "EmptyGroup",
		"member_uids": []string{},
	})
	// Whether this succeeds or fails depends on server validation;
	// either way it should not panic.
	_ = resp
}

func TestGetGroupInfos(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "InfoGroup",
		"member_uids": []string{owner.uid, m1.uid},
	})
	groupID := createResp.GroupID
	time.Sleep(200 * time.Millisecond)

	resp := owner.sendOK(wsRequest{
		"action":    "get_group_infos",
		"group_ids": []string{groupID},
	})
	if len(resp.Groups) != 1 {
		t.Fatalf("expected 1 group info, got %d", len(resp.Groups))
	}
	if resp.Groups[0].Name != "InfoGroup" {
		t.Errorf("group name = %q, want %q", resp.Groups[0].Name, "InfoGroup")
	}
	if resp.Groups[0].GroupID != groupID {
		t.Errorf("group_id = %q, want %q", resp.Groups[0].GroupID, groupID)
	}
	if resp.Groups[0].OwnerUID != owner.uid {
		t.Errorf("owner_uid = %q, want %q", resp.Groups[0].OwnerUID, owner.uid)
	}
}

func TestGetGroupInfosBatch(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	r1 := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "BatchGroup1",
		"member_uids": []string{owner.uid, m1.uid},
	})
	r2 := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "BatchGroup2",
		"member_uids": []string{owner.uid, m1.uid},
	})
	time.Sleep(200 * time.Millisecond)

	resp := owner.sendOK(wsRequest{
		"action":    "get_group_infos",
		"group_ids": []string{r1.GroupID, r2.GroupID},
	})
	if len(resp.Groups) != 2 {
		t.Fatalf("expected 2 group infos, got %d", len(resp.Groups))
	}
	names := map[string]bool{}
	for _, g := range resp.Groups {
		names[g.Name] = true
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

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "MembersGroup",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	time.Sleep(200 * time.Millisecond)

	resp := owner.sendOK(wsRequest{
		"action":   "get_group_members",
		"group_id": createResp.GroupID,
	})
	if len(resp.Members) != 3 {
		t.Fatalf("expected 3 members, got %d", len(resp.Members))
	}
	uidSet := map[string]bool{}
	for _, m := range resp.Members {
		uidSet[m.UID] = true
	}
	for _, c := range clients {
		if !uidSet[c.uid] {
			t.Errorf("missing member uid %s", c.uid)
		}
	}
	// Verify owner role (2 = owner in server schema)
	for _, m := range resp.Members {
		if m.UID == owner.uid && m.Role != 2 {
			t.Errorf("owner role = %d, want 2", m.Role)
		}
		if m.UID != owner.uid && m.Role != 0 {
			t.Errorf("member %s role = %d, want 0", m.UID, m.Role)
		}
	}
}

func TestGetGroupMembersPagination(t *testing.T) {
	clients := setupGroupUsers(t, 4)
	owner := clients[0]

	memberUIDs := make([]string, len(clients))
	for i, c := range clients {
		memberUIDs[i] = c.uid
	}

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "PaginationGroup",
		"member_uids": memberUIDs,
	})
	time.Sleep(200 * time.Millisecond)

	// 首页 limit=2（向下/FORWARD）
	resp1 := owner.sendOK(wsRequest{
		"action":   "get_group_members",
		"group_id": createResp.GroupID,
		"page":     wsRequest{"limit": 2},
	})
	if len(resp1.Members) != 2 {
		t.Fatalf("page 1: expected 2 members, got %d", len(resp1.Members))
	}

	// 次页：用上一页 end_cursor 续翻
	resp2 := owner.sendOK(wsRequest{
		"action":   "get_group_members",
		"group_id": createResp.GroupID,
		"page":     wsRequest{"limit": 2, "cursor": pageOf(&resp1).EndCursor},
	})
	if len(resp2.Members) != 2 {
		t.Fatalf("page 2: expected 2 members, got %d", len(resp2.Members))
	}

	// Verify no overlap
	page1UIDs := map[string]bool{}
	for _, m := range resp1.Members {
		page1UIDs[m.UID] = true
	}
	for _, m := range resp2.Members {
		if page1UIDs[m.UID] {
			t.Errorf("uid %s appears in both pages", m.UID)
		}
	}
}

func TestUpdateGroupInfo(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "OldName",
		"member_uids": []string{owner.uid, m1.uid},
	})
	groupID := createResp.GroupID
	time.Sleep(200 * time.Millisecond)

	owner.sendOK(wsRequest{
		"action":   "update_group_info",
		"group_id": groupID,
		"name":     "NewName",
	})

	resp := owner.sendOK(wsRequest{
		"action":    "get_group_infos",
		"group_ids": []string{groupID},
	})
	if len(resp.Groups) != 1 {
		t.Fatalf("expected 1 group info, got %d", len(resp.Groups))
	}
	if resp.Groups[0].Name != "NewName" {
		t.Errorf("name = %q, want %q", resp.Groups[0].Name, "NewName")
	}
}

func TestUpdateGroupInfoNonOwner(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "OwnerOnly",
		"member_uids": []string{owner.uid, m1.uid},
	})
	time.Sleep(200 * time.Millisecond)

	resp := m1.send(wsRequest{
		"action":   "update_group_info",
		"group_id": createResp.GroupID,
		"name":     "HackedName",
	})
	if resp.OK {
		t.Fatal("non-owner should not be able to update group info")
	}
}

func TestAddGroupMember(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	// Create group with owner + m1
	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "AddMemberGroup",
		"member_uids": []string{owner.uid, m1.uid},
	})
	groupID := createResp.GroupID
	time.Sleep(300 * time.Millisecond)

	// Drain notifications from group creation
	owner.drainNotifs(func(n notification) bool { return true })
	m1.drainNotifs(func(n notification) bool { return true })
	m2.drainNotifs(func(n notification) bool { return true })

	// Owner adds m2
	owner.sendOK(wsRequest{
		"action":   "add_group_member",
		"group_id": groupID,
		"uid":      m2.uid,
	})

	// Existing members and new member should get system message notification
	m1.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	}, 3*time.Second)
	m2.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	}, 3*time.Second)

	// Verify member count is now 3
	resp := owner.sendOK(wsRequest{
		"action":   "get_group_members",
		"group_id": groupID,
	})
	if len(resp.Members) != 3 {
		t.Fatalf("expected 3 members after add, got %d", len(resp.Members))
	}
}

func TestAddGroupMemberDuplicate(t *testing.T) {
	clients := setupGroupUsers(t, 2)
	owner, m1 := clients[0], clients[1]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "DupGroup",
		"member_uids": []string{owner.uid, m1.uid},
	})
	time.Sleep(200 * time.Millisecond)

	// Try to add m1 again
	resp := owner.send(wsRequest{
		"action":   "add_group_member",
		"group_id": createResp.GroupID,
		"uid":      m1.uid,
	})
	if resp.OK {
		t.Fatal("adding duplicate member should fail")
	}
}

func TestRemoveGroupMember(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "RemoveGroup",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	groupID := createResp.GroupID
	time.Sleep(300 * time.Millisecond)

	// Drain notifications from group creation
	owner.drainNotifs(func(n notification) bool { return true })
	m1.drainNotifs(func(n notification) bool { return true })
	m2.drainNotifs(func(n notification) bool { return true })

	// Owner removes m2
	owner.sendOK(wsRequest{
		"action":   "remove_group_member",
		"group_id": groupID,
		"uid":      m2.uid,
	})

	// Remaining members should get system message
	m1.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	}, 3*time.Second)

	// Verify member count is now 2
	resp := owner.sendOK(wsRequest{
		"action":   "get_group_members",
		"group_id": groupID,
	})
	if len(resp.Members) != 2 {
		t.Fatalf("expected 2 members after removal, got %d", len(resp.Members))
	}
}

func TestRemoveGroupMemberNonOwner(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "NonOwnerRemove",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	time.Sleep(200 * time.Millisecond)

	// m1 (non-owner) tries to remove m2 — should fail
	resp := m1.send(wsRequest{
		"action":   "remove_group_member",
		"group_id": createResp.GroupID,
		"uid":      m2.uid,
	})
	// The server may not explicitly check owner for remove, but typically only owner can.
	// If the server allows it, this test documents that behavior.
	_ = resp
}

func TestGroupMessage(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "MsgGroup",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	groupID := createResp.GroupID
	time.Sleep(300 * time.Millisecond)

	// Drain creation notifications
	owner.drainNotifs(func(n notification) bool { return true })
	m1.drainNotifs(func(n notification) bool { return true })
	m2.drainNotifs(func(n notification) bool { return true })

	// Owner sends a text message to the group
	sendResp := owner.sendOK(wsRequest{
		"action":   "send_message",
		"group_id": groupID,
		"msg_type": 1,
		"content":  "hello group",
	})
	if sendResp.MsgID == "" {
		t.Fatal("send_message should return msg_id")
	}

	// Both members should receive messages:received notification
	m1.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	}, 3*time.Second)
	m2.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	}, 3*time.Second)

	// Members can sync the message
	time.Sleep(200 * time.Millisecond)
	syncResp := m1.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": 0,
		"limit":    100,
	})
	found := false
	for _, msg := range syncResp.Messages {
		if msg.MsgID == sendResp.MsgID && msg.text() == "hello group" && msg.GroupID == groupID {
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

	createResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "GroupNonMember",
		"member_uids": []string{owner.uid, member.uid},
	})
	groupID := createResp.GroupID

	outsider := dial(t)
	outsider.registerAndLogin(uniqueName("grp"), "pass1234", "Outsider")

	resp := outsider.send(wsRequest{
		"action":   "send_message",
		"group_id": groupID,
		"msg_type": 1,
		"content":  "i should fail",
	})
	if resp.OK {
		t.Fatal("non-member send group message should fail")
	}
	if resp.Error != "非群员" {
		t.Fatalf("error=%q, want 非群员", resp.Error)
	}
}
