package dal

import "testing"

func TestCreateGroupAndGetInfo(t *testing.T) {
	db := setupDB(t)
	store := NewGroupStore(db.GroupShards.AllShards()[0])

	err := store.CreateGroup(100, "Test Group", 1, []int64{1, 2, 3}, 1000)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	info, err := store.GetInfo(100)
	if err != nil {
		t.Fatalf("GetInfo: %v", err)
	}
	if info == nil {
		t.Fatal("info should not be nil")
	}
	if info.Name != "Test Group" || info.OwnerUID != 1 {
		t.Errorf("unexpected info: %+v", info)
	}

	// Verify member roles
	members, err := store.ListAllMembers(100)
	if err != nil {
		t.Fatalf("ListAllMembers: %v", err)
	}
	if len(members) != 3 {
		t.Fatalf("got %d members, want 3", len(members))
	}
	for _, m := range members {
		if m.UID == 1 && m.Role != RoleOwner {
			t.Errorf("owner should have RoleOwner, got %d", m.Role)
		}
		if m.UID != 1 && m.Role != RoleMember {
			t.Errorf("member %d should have RoleMember, got %d", m.UID, m.Role)
		}
	}

	// Nonexistent group
	info, _ = store.GetInfo(9999)
	if info != nil {
		t.Error("nonexistent group should return nil")
	}
}

func TestAddRemoveMember(t *testing.T) {
	db := setupDB(t)
	store := NewGroupStore(db.GroupShards.AllShards()[0])

	store.CreateGroup(100, "G", 1, []int64{1}, 1000)

	// Add member
	ok, err := store.AddMember(100, 2, RoleMember, 2000)
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if !ok {
		t.Error("first add should return true")
	}

	// Add duplicate
	ok, _ = store.AddMember(100, 2, RoleMember, 3000)
	if ok {
		t.Error("duplicate add should return false")
	}

	// Remove
	ok, err = store.RemoveMember(100, 2)
	if err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if !ok {
		t.Error("remove existing should return true")
	}

	members, _ := store.ListAllMembers(100)
	if len(members) != 1 {
		t.Errorf("got %d members after remove, want 1", len(members))
	}
}

func TestIsMember(t *testing.T) {
	db := setupDB(t)
	store := NewGroupStore(db.GroupShards.AllShards()[0])

	store.CreateGroup(100, "G", 1, []int64{1, 2}, 1000)

	ok, err := store.IsMember(100, 1)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if !ok {
		t.Error("member 1 should be found")
	}

	ok, err = store.IsMember(100, 999)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if ok {
		t.Error("nonexistent member should return false")
	}
}
