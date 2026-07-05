package dal

import "testing"

func TestInsertAndGetUID(t *testing.T) {
	db := setupDB(t)
	store := NewUserLookupStore(db.UsernameShards.AllShards()[0])

	ok, err := store.Insert("alice", 1001)
	if err != nil {
		t.Fatalf("InsertLookup: %v", err)
	}
	if !ok {
		t.Error("first insert should return true")
	}

	uid, err := store.GetUID("alice")
	if err != nil {
		t.Fatalf("GetUID: %v", err)
	}
	if uid != 1001 {
		t.Errorf("got uid %d, want 1001", uid)
	}

	// Not found
	uid, err = store.GetUID("nonexistent")
	if err != nil {
		t.Fatalf("GetUID: %v", err)
	}
	if uid != 0 {
		t.Errorf("got uid %d, want 0 for nonexistent", uid)
	}
}

func TestDuplicateInsertIgnored(t *testing.T) {
	db := setupDB(t)
	store := NewUserLookupStore(db.UsernameShards.AllShards()[0])

	store.Insert("alice", 1001)

	ok, err := store.Insert("alice", 2002)
	if err != nil {
		t.Fatalf("InsertLookup duplicate: %v", err)
	}
	if ok {
		t.Error("duplicate insert should return false")
	}

	// Original value preserved
	uid, _ := store.GetUID("alice")
	if uid != 1001 {
		t.Errorf("got uid %d, want 1001 (original)", uid)
	}
}
