package dal

import "testing"

func TestCreateAndGetSession(t *testing.T) {
	db := setupDB(t)
	store := NewSessionStore(db.TokenShards.AllShards()[0])

	err := store.Create("tok1", 1001, 1000, 9999)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	sess, err := store.Get("tok1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if sess == nil {
		t.Fatal("session should not be nil")
	}
	if sess.UID != 1001 || sess.ExpireAt != 9999 {
		t.Errorf("unexpected session: %+v", sess)
	}
}

func TestDeleteSession(t *testing.T) {
	db := setupDB(t)
	store := NewSessionStore(db.TokenShards.AllShards()[0])

	store.Create("tok1", 1001, 1000, 9999)

	err := store.Delete("tok1")
	if err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	sess, err := store.Get("tok1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if sess != nil {
		t.Error("deleted session should return nil")
	}
}

func TestPurge(t *testing.T) {
	db := setupDB(t)
	store := NewSessionStore(db.TokenShards.AllShards()[0])

	store.Create("expired", 1001, 1000, 2000)
	store.Create("valid", 1002, 1000, 5000)

	n, err := store.Purge(3000, 100)
	if err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if n != 1 {
		t.Errorf("should delete 1, got %d", n)
	}

	// Expired one gone
	sess, _ := store.Get("expired")
	if sess != nil {
		t.Error("expired session should be gone")
	}

	// Valid one remains
	sess, _ = store.Get("valid")
	if sess == nil {
		t.Error("valid session should remain")
	}
}
