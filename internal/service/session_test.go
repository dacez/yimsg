package service

import (
	"testing"
)

func TestAuthenticateSuccess(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	resp := authenticateTokenService(s, "r1", token)
	if !isOK(resp) {
		t.Fatalf("authenticate failed: %s", errMsg(resp))
	}
	if resp.GetUid() != uid {
		t.Errorf("uid mismatch: got %v, want %d", resp.GetUid(), uid)
	}
}

func TestAuthenticateInvalidToken(t *testing.T) {
	s := testState(t)
	resp := authenticateTokenService(s, "r1", "invalid-token-xxx")
	if isOK(resp) {
		t.Error("invalid token should fail")
	}
}

func TestLogoutSuccess(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	resp := logoutService(s, "r1", token)
	if !isOK(resp) {
		t.Fatalf("logout failed: %s", errMsg(resp))
	}

	// Token should be invalid after logout
	authResp := authenticateTokenService(s, "r2", token)
	if isOK(authResp) {
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
	if !isOK(resp) {
		t.Errorf("logout nonexistent should succeed, got error: %s", errMsg(resp))
	}
}
