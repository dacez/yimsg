package auth

import (
	"testing"
	"yimsg/server/internal/config"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/shard"
)

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("secret123")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !VerifyPassword("secret123", hash) {
		t.Error("correct password should verify")
	}
	if VerifyPassword("wrong", hash) {
		t.Error("wrong password should not verify")
	}
}

func TestGenerateToken(t *testing.T) {
	tok1, err := GenerateToken(16)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if len(tok1) != 32 { // 16 bytes * 2 hex chars
		t.Errorf("expected length 32, got %d", len(tok1))
	}

	tok2, err := GenerateToken(16)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if tok1 == tok2 {
		t.Error("two tokens should differ")
	}
}

func TestVerifyWrongHash(t *testing.T) {
	if VerifyPassword("anything", "not-a-valid-hash") {
		t.Error("invalid hash should return false")
	}
}

func TestAuthenticateAutoRenew(t *testing.T) {
	db, err := shard.OpenMemory(1, dal.Schemas())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	token := "test-token-abc"
	cfg := &config.SessionConfig{TTLSeconds: 100, TokenBytes: 16}

	now := NowMs()
	// Create session that's close to expiry: expires in 30s, TTL is 100s, so remaining < 50s (half)
	store := dal.NewSessionStore(db.TokenShards.AllShards()[0])
	store.Create(token, 1001, now, now+30_000)

	uid, err := Authenticate(db.TokenShards, cfg, token)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if uid != 1001 {
		t.Errorf("uid = %d, want 1001", uid)
	}

	// Verify expire_at was renewed (should be now + TTL*1000)
	sess, _ := store.Get(token)
	if sess == nil {
		t.Fatal("session should still exist")
	}
	// After renewal: expire_at should be > now + 90_000 (approximately now + 100_000)
	if sess.ExpireAt < now+90_000 {
		t.Errorf("expire_at = %d, expected renewal (should be > %d)", sess.ExpireAt, now+90_000)
	}
}
