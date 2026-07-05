package dal

import "testing"

func TestCreateAndGetUser(t *testing.T) {
	db := setupDB(t)
	store := NewUserStore(db.UIDShards.AllShards()[0])

	err := store.Create(1001, "alice", "hash123", "Alice", 1000)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	u, err := store.Get(1001)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if u == nil {
		t.Fatal("user should not be nil")
	}
	if u.Username != "alice" || u.Nickname != "Alice" || u.PasswordHash != "hash123" {
		t.Errorf("unexpected user data: %+v", u)
	}
}

func TestGetUserNotFound(t *testing.T) {
	db := setupDB(t)
	store := NewUserStore(db.UIDShards.AllShards()[0])

	u, err := store.Get(9999)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if u != nil {
		t.Error("should return nil for nonexistent user")
	}
}

func TestUpdateProfile(t *testing.T) {
	db := setupDB(t)
	store := NewUserStore(db.UIDShards.AllShards()[0])

	store.Create(1001, "alice", "hash", "Alice", 1000)

	ok, err := store.UpdateProfile(1001, "NewAlice", "avatar.jpg", 2000)
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if !ok {
		t.Error("should return true for existing user")
	}

	u, err := store.Get(1001)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if u.Nickname != "NewAlice" || u.Avatar != "avatar.jpg" {
		t.Errorf("unexpected profile: %+v", u)
	}
}
