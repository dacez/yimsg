package dal

import "testing"

func TestAddAndListTokens(t *testing.T) {
	db := setupDB(t)
	store := NewUserSessionStore(db.UIDShards.AllShards()[0])

	store.AddToken(1, "tok_a", "ios", 1000)
	store.AddToken(1, "tok_b", "web", 2000)

	tokens, err := store.ListTokens(1)
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
	}
	if len(tokens) != 2 {
		t.Fatalf("got %d tokens, want 2", len(tokens))
	}
}

func TestRemoveTokens(t *testing.T) {
	db := setupDB(t)
	store := NewUserSessionStore(db.UIDShards.AllShards()[0])

	store.AddToken(1, "tok_a", "ios", 1000)
	store.AddToken(1, "tok_b", "web", 2000)

	err := store.RemoveTokens(1)
	if err != nil {
		t.Fatalf("RemoveTokens: %v", err)
	}

	tokens, _ := store.ListTokens(1)
	if len(tokens) != 0 {
		t.Errorf("got %d tokens after RemoveTokens, want 0", len(tokens))
	}
}
