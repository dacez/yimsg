package service

import (
	"testing"
)

func TestAuthenticateSuccess(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	resp := authenticateTokenService(s, "r1", token)
	if !resp.OK {
		t.Fatalf("authenticate failed: %s", resp.Error)
	}
	if resp.UID == nil || int64(*resp.UID) != uid {
		t.Errorf("uid mismatch: got %v, want %d", resp.UID, uid)
	}
}

func TestAuthenticateInvalidToken(t *testing.T) {
	s := testState(t)
	resp := authenticateTokenService(s, "r1", "invalid-token-xxx")
	if resp.OK {
		t.Error("invalid token should fail")
	}
}

func TestLogoutSuccess(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	resp := logoutService(s, "r1", token)
	if !resp.OK {
		t.Fatalf("logout failed: %s", resp.Error)
	}

	// Token should be invalid after logout
	authResp := authenticateTokenService(s, "r2", token)
	if authResp.OK {
		t.Error("token should be invalid after logout")
	}
}

func TestLogoutCleansUserSession(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	logoutService(s, "r1", token)

	usStore := s.UserSessionStore(uid)
	tokens, _ := usStore.ListTokens(uid)
	for _, us := range tokens {
		if us.Token == token {
			t.Error("token should be removed from user_session after logout")
		}
	}
}

func TestLogoutNonexistentToken(t *testing.T) {
	s := testState(t)
	resp := logoutService(s, "r1", "nonexistent-token")
	if !resp.OK {
		t.Errorf("logout nonexistent should succeed, got error: %s", resp.Error)
	}
}
