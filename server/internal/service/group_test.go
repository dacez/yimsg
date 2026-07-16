package service

import (
	"fmt"
	"testing"
	"yimsg/server/internal/dal"
)

func TestCreateGroupSuccess(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	if !isOK(resp) {
		t.Fatalf("create_group failed: %s", errMsg(resp))
	}
	if resp.GetGroupId() <= 0 {
		t.Error("group_id should be positive")
	}
}

func TestCreateGroupOwnerNotInList(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	// Owner not in member list → should be auto-added
	resp := createGroupService(s, "r1", uidA, "G", []int64{uidB})
	if !isOK(resp) {
		t.Fatalf("create_group failed: %s", errMsg(resp))
	}

	groupID := resp.GetGroupId()
	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if !isOK(members) {
		t.Fatalf("get_group_members failed: %s", errMsg(members))
	}

	ownerFound := false
	for _, m := range members.GetMembers() {
		if m.GetUid() == uidA {
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
	groupID := resp.GetGroupId()

	detail := getGroupInfosService(s, "r2", uidA, []int64{groupID})
	if !isOK(detail) {
		t.Fatalf("get_group_infos failed: %s", errMsg(detail))
	}
	if len(detail.GetGroups()) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.GetGroups()))
	}
	if detail.GetGroups()[0].GetName() != "TestGroup" {
		t.Errorf("name = %q, want TestGroup", detail.GetGroups()[0].GetName())
	}
}

func TestGetGroupInfosEmpty(t *testing.T) {
	s := testState(t)
	resp := getGroupInfosService(s, "r1", 0, []int64{9999})
	if !isOK(resp) {
		t.Error("get_group_infos with nonexistent id should still succeed")
	}
	if len(resp.GetGroups()) != 0 {
		t.Errorf("groups count = %d, want 0", len(resp.GetGroups()))
	}
}

func TestGetGroupMembersCount(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	groupID := resp.GetGroupId()

	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if len(members.GetMembers()) != 3 {
		t.Errorf("members count = %d, want 3", len(members.GetMembers()))
	}
	if members.GetPage().GetTotal() != 3 {
		t.Fatalf("members total = %v, want 3", members.GetPage().GetTotal())
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
	groupID := resp.GetGroupId()

	members := getGroupMembersService(s, "r2", groupID, "", 999)
	if len(members.GetMembers()) != 500 {
		t.Fatalf("members window length = %d, want 500", len(members.GetMembers()))
	}
	if members.GetPage().GetTotal() != 521 {
		t.Fatalf("members total = %v, want 521", members.GetPage().GetTotal())
	}
}

func TestGetGroupMembersReturnsMembers(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	members := getGroupMembersService(s, "r2", groupID, "", 200)
	if len(members.GetMembers()) != 2 {
		t.Errorf("expected 2 members, got %d", len(members.GetMembers()))
	}
}

func TestUpdateGroupInfoService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "OldName", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	updateResp := updateGroupInfoService(s, "r2", uidA, groupID, "NewName", "avatar.png")
	if !isOK(updateResp) {
		t.Fatalf("update_group_info failed: %s", errMsg(updateResp))
	}

	detail := getGroupInfosService(s, "r3", uidA, []int64{groupID})
	if len(detail.GetGroups()) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.GetGroups()))
	}
	if detail.GetGroups()[0].GetName() != "NewName" {
		t.Errorf("name = %q, want NewName", detail.GetGroups()[0].GetName())
	}
	if detail.GetGroups()[0].GetAvatar() != "avatar.png" {
		t.Errorf("avatar = %q, want avatar.png", detail.GetGroups()[0].GetAvatar())
	}
}

func TestAddGroupMemberService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	addResp := addGroupMemberService(s, "r2", uidA, groupID, uidC)
	if !isOK(addResp) {
		t.Fatalf("add_group_member failed: %s", errMsg(addResp))
	}

	members := getGroupMembersService(s, "r3", groupID, "", 200)
	if len(members.GetMembers()) != 3 {
		t.Errorf("members = %d, want 3", len(members.GetMembers()))
	}
}

func TestAddGroupMemberDuplicate(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	addResp := addGroupMemberService(s, "r2", uidA, groupID, uidB)
	if isOK(addResp) {
		t.Error("duplicate member should fail")
	}
	if errMsg(addResp) != "member already exists" {
		t.Errorf("got error %q", errMsg(addResp))
	}
}

func TestRemoveGroupMemberService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	removeResp := removeGroupMemberService(s, "r2", uidA, groupID, uidB)
	if !isOK(removeResp) {
		t.Fatalf("remove_group_member failed: %s", errMsg(removeResp))
	}

	members := getGroupMembersService(s, "r3", groupID, "", 200)
	if len(members.GetMembers()) != 1 {
		t.Errorf("members = %d, want 1", len(members.GetMembers()))
	}
}

func TestGetGroupInfosDoesNotReturnRemarks(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	groupID := resp.GetGroupId()

	// Alice adds group to contacts with a remark
	store := s.ContactStore(uidA)
	_, err := store.Upsert(uidA, 0, groupID, 0, dal.ContactFriend, "MyGroup", dal.ContactSortKey("MyGroup", "MyGroup"), dal.ContactSearchText("MyGroup", "MyGroup"), 1000)
	if err != nil {
		t.Fatalf("upsert group contact: %v", err)
	}

	detail := getGroupInfosService(s, "r2", uidA, []int64{groupID})
	if !isOK(detail) {
		t.Fatalf("get_group_infos failed: %s", errMsg(detail))
	}
	if len(detail.GetGroups()) != 1 {
		t.Fatalf("groups count = %d, want 1", len(detail.GetGroups()))
	}
	// pb.GroupInfo 本身不携带 remark 字段（关系态数据不进入群展示资料），
	// 由类型系统在编译期保证 get_group_infos 不会泄露备注。
}

func TestGetGroupInfosRefreshesUnremarkedContactProjection(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := createGroupService(s, "r1", uidA, "OldGroup", []int64{uidA, uidB})
	groupID := resp.GetGroupId()
	if favorite := favoriteGroupService(s, "r2", uidA, groupID, ""); !isOK(favorite) {
		t.Fatalf("favorite_group failed: %s", errMsg(favorite))
	}

	before, _ := s.ContactStore(uidA).GetByKey(uidA, 0, groupID, 0)
	if before == nil || before.SearchText != "OldGroup" || before.SortKey != "oldgroup" {
		t.Fatalf("initial group contact = %+v, want projection OldGroup/oldgroup", before)
	}

	updateGroupInfoService(s, "r3", uidA, groupID, "NewGroup", "")
	detail := getGroupInfosService(s, "r4", uidA, []int64{groupID})
	if !isOK(detail) {
		t.Fatalf("get_group_infos failed: %s", errMsg(detail))
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
	groupID := resp.GetGroupId()

	// Bob has no group contact remark
	detail := getGroupInfosService(s, "r2", uidB, []int64{groupID})
	if !isOK(detail) {
		t.Fatalf("get_group_infos failed: %s", errMsg(detail))
	}
	// pb.GroupInfo 本身不携带 remark 字段，无联系人记录时更不可能有备注（编译期保证）。
}

func TestRemoveGroupMemberNotFound(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")

	resp := createGroupService(s, "r1", uidA, "G", []int64{uidA})
	groupID := resp.GetGroupId()

	removeResp := removeGroupMemberService(s, "r2", uidA, groupID, 9999)
	if isOK(removeResp) {
		t.Error("nonexistent member should fail")
	}
	if errMsg(removeResp) != "member not found" {
		t.Errorf("got error %q", errMsg(removeResp))
	}
}
