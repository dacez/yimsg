package service

import (
	"fmt"
	"testing"
	"yimsg/internal/dal"
)

func TestCreateGroupSuccess(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	if !resp.OK {
		t.Fatalf("create_group failed: %s", resp.Error)
	}
	if resp.GroupIDResp == nil || int64(*resp.GroupIDResp) <= 0 {
		t.Error("group_id should be positive")
	}
}

func TestCreateGroupOwnerNotInList(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	// Owner not in member list → should be auto-added
	resp := createGroupService(s, "r1", uidA, "G", []int64{uidB})
	if !resp.OK {
		t.Fatalf("create_group failed: %s", resp.Error)
	}

	groupID := int64(*resp.GroupIDResp)
	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if !members.OK {
		t.Fatalf("get_group_members failed: %s", members.Error)
	}

	ownerFound := false
	for _, m := range members.Members {
		if int64(m.UID) == uidA {
			ownerFound = true
		}
	}
	if !ownerFound {
		t.Error("owner should be auto-added to group")
	}
}

func TestGetGroupInfosSuccess(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	detail := getGroupInfosService(s, "r2", uidA, []int64{groupID})
	if !detail.OK {
		t.Fatalf("get_group_infos failed: %s", detail.Error)
	}
	if len(detail.Groups) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.Groups))
	}
	if detail.Groups[0].Name != "TestGroup" {
		t.Errorf("name = %q, want TestGroup", detail.Groups[0].Name)
	}
}

func TestGetGroupInfosEmpty(t *testing.T) {
	s := testState(t)
	resp := getGroupInfosService(s, "r1", 0, []int64{9999})
	if !resp.OK {
		t.Error("get_group_infos with nonexistent id should still succeed")
	}
	if len(resp.Groups) != 0 {
		t.Errorf("groups count = %d, want 0", len(resp.Groups))
	}
}

func TestGetGroupMembersCount(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	groupID := int64(*resp.GroupIDResp)

	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if len(members.Members) != 3 {
		t.Errorf("members count = %d, want 3", len(members.Members))
	}
	if members.Total == nil || *members.Total != 3 {
		t.Fatalf("members total = %v, want 3", members.Total)
	}
}

func TestGetGroupMembersWindowLimit(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	memberUIDs := []int64{uidA}
	for i := 0; i < 520; i++ {
		memberUIDs = append(memberUIDs, registerUser(t, s, fmt.Sprintf("member_%d", i), "p", "Member"))
	}

	resp := createGroupService(s, "r1", uidA, "G", memberUIDs)
	groupID := int64(*resp.GroupIDResp)

	members := getGroupMembersService(s, "r2", groupID, "", 999)
	if len(members.Members) != 500 {
		t.Fatalf("members window length = %d, want 500", len(members.Members))
	}
	if members.Total == nil || *members.Total != 521 {
		t.Fatalf("members total = %v, want 521", members.Total)
	}
}

func TestGetGroupMembersReturnsMembers(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if len(members.Members) != 2 {
		t.Errorf("expected 2 members, got %d", len(members.Members))
	}
}

func TestUpdateGroupInfoService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "OldName", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	updateResp := updateGroupInfoService(s, "r2", uidA, groupID, "NewName", "avatar.png")
	if !updateResp.OK {
		t.Fatalf("update_group_info failed: %s", updateResp.Error)
	}

	detail := getGroupInfosService(s, "r3", uidA, []int64{groupID})
	if len(detail.Groups) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.Groups))
	}
	if detail.Groups[0].Name != "NewName" {
		t.Errorf("name = %q, want NewName", detail.Groups[0].Name)
	}
	if detail.Groups[0].Avatar != "avatar.png" {
		t.Errorf("avatar = %q, want avatar.png", detail.Groups[0].Avatar)
	}
}

func TestAddGroupMemberService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	addResp := addGroupMemberService(s, "r2", uidA, groupID, uidC)
	if !addResp.OK {
		t.Fatalf("add_group_member failed: %s", addResp.Error)
	}

	members := getGroupMembersService(s, "r3", groupID, "", 200)
	if len(members.Members) != 3 {
		t.Errorf("members = %d, want 3", len(members.Members))
	}
}

func TestAddGroupMemberDuplicate(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	addResp := addGroupMemberService(s, "r2", uidA, groupID, uidB)
	if addResp.OK {
		t.Error("duplicate member should fail")
	}
	if addResp.Error != "member already exists" {
		t.Errorf("got error %q", addResp.Error)
	}
}

func TestRemoveGroupMemberService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	removeResp := removeGroupMemberService(s, "r2", uidA, groupID, uidB)
	if !removeResp.OK {
		t.Fatalf("remove_group_member failed: %s", removeResp.Error)
	}

	members := getGroupMembersService(s, "r3", groupID, "", 200)
	if len(members.Members) != 1 {
		t.Errorf("members = %d, want 1", len(members.Members))
	}
}

func TestGetGroupInfosDoesNotReturnRemarks(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	// Alice adds group to contacts with a remark
	store := s.ContactStore(uidA)
	_, err := store.Upsert(uidA, 0, groupID, 0, dal.ContactFriend, "MyGroup", dal.ContactSortKey("MyGroup", "MyGroup"), dal.ContactSearchText("MyGroup", "MyGroup"), 1000)
	if err != nil {
		t.Fatalf("upsert group contact: %v", err)
	}

	detail := getGroupInfosService(s, "r2", uidA, []int64{groupID})
	if !detail.OK {
		t.Fatalf("get_group_infos failed: %s", detail.Error)
	}
	if len(detail.Groups) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.Groups))
	}
	if detail.Groups[0].Remark != "" {
		t.Errorf("group profile should not include relationship remark, got %q", detail.Groups[0].Remark)
	}
}

func TestGetGroupInfosRefreshesUnremarkedContactProjection(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "OldGroup", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)
	if favorite := favoriteGroupService(s, "r2", uidA, groupID, ""); !favorite.OK {
		t.Fatalf("favorite_group failed: %s", favorite.Error)
	}

	before, _ := s.ContactStore(uidA).GetByKey(uidA, 0, groupID, 0)
	if before == nil || before.SearchText != "OldGroup" || before.SortKey != "oldgroup" {
		t.Fatalf("initial group contact = %+v, want projection OldGroup/oldgroup", before)
	}

	updateGroupInfoService(s, "r3", uidA, groupID, "NewGroup", "")
	detail := getGroupInfosService(s, "r4", uidA, []int64{groupID})
	if !detail.OK {
		t.Fatalf("get_group_infos failed: %s", detail.Error)
	}
	after, _ := s.ContactStore(uidA).GetByKey(uidA, 0, groupID, 0)
	if after.Status != dal.ContactFriend || after.SearchText != "NewGroup" || after.SortKey != "newgroup" {
		t.Fatalf("group contact after refresh = %+v, want friend projection NewGroup/newgroup", after)
	}
	if after.Seq <= before.Seq {
		t.Fatalf("seq should increase, before=%d after=%d", before.Seq, after.Seq)
	}
}

func TestGetGroupInfosNoRemarkWithoutContact(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	groupID := int64(*resp.GroupIDResp)

	// Bob has no group contact remark
	detail := getGroupInfosService(s, "r2", uidB, []int64{groupID})
	if !detail.OK {
		t.Fatalf("get_group_infos failed: %s", detail.Error)
	}
	if detail.Groups[0].Remark != "" {
		t.Errorf("remark should be empty, got %q", detail.Groups[0].Remark)
	}
}

func TestRemoveGroupMemberNotFound(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA})
	groupID := int64(*resp.GroupIDResp)

	removeResp := removeGroupMemberService(s, "r2", uidA, groupID, 9999)
	if removeResp.OK {
		t.Error("nonexistent member should fail")
	}
	if removeResp.Error != "member not found" {
		t.Errorf("got error %q", removeResp.Error)
	}
}
