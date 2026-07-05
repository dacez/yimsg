package service

import (
	"testing"
	"yimsg/internal/dal"
)

func TestRegisterSuccess(t *testing.T) {
	s := testState(t)
	resp := registerService(s, "r1", "alice", "pass123", "Alice")
	if !resp.OK {
		t.Fatalf("expected ok, got error: %s", resp.Error)
	}
	if resp.UID == nil || int64(*resp.UID) <= 0 {
		t.Error("uid should be positive")
	}
}

func TestRegisterDuplicateUsername(t *testing.T) {
	s := testState(t)
	registerService(s, "r1", "alice", "pass123", "Alice")
	resp := registerService(s, "r2", "alice", "other", "Alice2")
	if resp.OK {
		t.Error("duplicate username should fail")
	}
	if resp.Error != "username already exists" {
		t.Errorf("got error %q", resp.Error)
	}
}

func TestRegisterInitsContactVersion(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	// get_contacts should work immediately after registration
	resp := listContactsService(s, "r1", uid, dal.ContactListFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_contacts failed: %s", resp.Error)
	}
}

func TestLoginSuccess(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass123", "Alice")

	resp := loginService(s, "r1", "alice", "pass123")
	if !resp.OK {
		t.Fatalf("login failed: %s", resp.Error)
	}
	if resp.Token == "" {
		t.Error("token should not be empty")
	}
	if resp.UID == nil || int64(*resp.UID) <= 0 {
		t.Error("uid should be positive")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass123", "Alice")

	resp := loginService(s, "r1", "alice", "wrong")
	if resp.OK {
		t.Error("wrong password should fail")
	}
	if resp.Error != "wrong password" {
		t.Errorf("got error %q", resp.Error)
	}
}

func TestLoginUserNotFound(t *testing.T) {
	s := testState(t)
	resp := loginService(s, "r1", "nonexistent", "pass")
	if resp.OK {
		t.Error("nonexistent user should fail")
	}
	if resp.Error != "user not found" {
		t.Errorf("got error %q", resp.Error)
	}
}

func TestGetProfileSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := getUserInfosService(s, "r1", uid, []int64{uid})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	if len(resp.Profiles) == 0 {
		t.Fatal("profile should not be empty")
	}
	if resp.Profiles[0].Nickname != "Alice" {
		t.Errorf("nickname = %q, want Alice", resp.Profiles[0].Nickname)
	}
}

func TestGetUserInfosNotFound(t *testing.T) {
	s := testState(t)
	resp := getUserInfosService(s, "r1", 0, []int64{9999})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	if len(resp.Profiles) != 0 {
		t.Errorf("nonexistent user should return empty profiles, got %d", len(resp.Profiles))
	}
}

func TestUpdateUserInfoSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := updateUserInfoService(s, "r1", uid, "NewAlice", "avatar.jpg")
	if !resp.OK {
		t.Fatalf("update_user_info failed: %s", resp.Error)
	}

	profile := getUserInfosService(s, "r2", uid, []int64{uid})
	if len(profile.Profiles) == 0 || profile.Profiles[0].Nickname != "NewAlice" || profile.Profiles[0].Avatar != "avatar.jpg" {
		t.Errorf("profile not updated: %+v", profile.Profiles)
	}
}

func TestUpdatePasswordSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "oldpass", "Alice")

	resp := updatePasswordService(s, "r1", uid, "oldpass", "newpass")
	if !resp.OK {
		t.Fatalf("update_password failed: %s", resp.Error)
	}

	// New password works
	loginResp := loginService(s, "r2", "alice", "newpass")
	if !loginResp.OK {
		t.Error("login with new password should succeed")
	}

	// Old password fails
	loginResp = loginService(s, "r3", "alice", "oldpass")
	if loginResp.OK {
		t.Error("login with old password should fail")
	}
}

func TestUpdatePasswordWrongOld(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := updatePasswordService(s, "r1", uid, "wrong", "newpass")
	if resp.OK {
		t.Error("wrong old password should fail")
	}
	if resp.Error != "wrong old password" {
		t.Errorf("got error %q", resp.Error)
	}
}

func TestUpdatePasswordKicksSessions(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	// Verify token works
	authResp := authenticateTokenService(s, "r1", token)
	if !authResp.OK {
		t.Fatal("token should work before password change")
	}

	updatePasswordService(s, "r2", uid, "pass", "newpass")

	// Old token should be invalid
	authResp = authenticateTokenService(s, "r3", token)
	if authResp.OK {
		t.Error("old token should be invalidated after password change")
	}
}

func TestLoginCreatesUserSession(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	usStore := s.UserSessionStore(uid)
	tokens, err := usStore.ListTokens(uid)
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
	}
	found := false
	for _, us := range tokens {
		if us.Token == token {
			found = true
			break
		}
	}
	if !found {
		t.Error("login should create user_session entry")
	}
}

func TestUpdatePasswordClearsUserSession(t *testing.T) {
	s := testState(t)
	uid, _ := registerAndLogin(t, s, "alice", "pass", "Alice")

	updatePasswordService(s, "r1", uid, "pass", "newpass")

	usStore := s.UserSessionStore(uid)
	tokens, _ := usStore.ListTokens(uid)
	if len(tokens) != 0 {
		t.Errorf("user_session should be empty after password change, got %d", len(tokens))
	}
}

func TestGetUserInfosDoesNotReturnRemarks(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	// Alice adds Bob with remark "Bobby" and Carol without remark
	makeFriends(t, s, uidA, uidB)
	updateRemarkService(s, "r1", uidA, uidB, 0, "Bobby")
	makeFriends(t, s, uidA, uidC)

	resp := getUserInfosService(s, "r2", uidA, []int64{uidB, uidC})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	if len(resp.Profiles) != 2 {
		t.Fatalf("profiles count = %d, want 2", len(resp.Profiles))
	}
	found := false
	for _, p := range resp.Profiles {
		if p.UID == uidB {
			found = true
			if p.Remark != "" {
				t.Errorf("user profile should not include relationship remark, got %q", p.Remark)
			}
		}
	}
	if !found {
		t.Fatal("bob profile not found")
	}
}

func TestGetUserInfosRefreshesUnremarkedContactProjection(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	before, _ := s.ContactStore(uidA).Get(uidA, uidB)
	if before == nil || before.SearchText != "Bob" || before.SortKey != "bob" {
		t.Fatalf("initial contact = %+v, want projection Bob/bob", before)
	}

	updateUserInfoService(s, "r1", uidB, "Bobby", "")
	resp := getUserInfosService(s, "r2", uidA, []int64{uidB})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	after, _ := s.ContactStore(uidA).Get(uidA, uidB)
	// search_text 只含昵称 Bobby，不含 username（bob）。
	if after.SearchText != "Bobby" || after.SortKey != "bobby" {
		t.Fatalf("projection = sort:%q search:%q, want bobby/Bobby", after.SortKey, after.SearchText)
	}
	if after.Seq <= before.Seq {
		t.Fatalf("seq should increase, before=%d after=%d", before.Seq, after.Seq)
	}
}

func TestGetProfileRefreshesUnremarkedContactProjection(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	updateUserInfoService(s, "r1", uidB, "Bobby", "")
	resp := getUserInfosService(s, "r2", uidA, []int64{uidB})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	contact, _ := s.ContactStore(uidA).Get(uidA, uidB)
	if contact.SearchText != "Bobby" {
		t.Fatalf("search_text = %q, want Bobby", contact.SearchText)
	}
}

func TestGetUserInfosNoRemarkForStranger(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	// No friend relationship
	resp := getUserInfosService(s, "r1", uidA, []int64{uidB})
	if !resp.OK {
		t.Fatalf("get_user_infos failed: %s", resp.Error)
	}
	if len(resp.Profiles) != 1 {
		t.Fatalf("profiles count = %d, want 1", len(resp.Profiles))
	}
	// No remark for stranger
	if resp.Profiles[0].Remark != "" {
		t.Errorf("remark should be empty for stranger, got %q", resp.Profiles[0].Remark)
	}
}

func TestSearchUserFound(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass", "Alice")

	resp := searchUserService(s, "r1", 0, "alice")
	if !resp.OK {
		t.Fatalf("search failed: %s", resp.Error)
	}
	if resp.Profile == nil {
		t.Fatal("profile should not be nil")
	}
	if resp.Profile.Nickname != "Alice" {
		t.Errorf("nickname = %q, want Alice", resp.Profile.Nickname)
	}
}

func TestSearchUserNotFound(t *testing.T) {
	s := testState(t)
	resp := searchUserService(s, "r1", 0, "nonexistent")
	if !resp.OK {
		t.Fatalf("search should return ok even for not found")
	}
	if resp.Profile != nil {
		t.Error("profile should be nil for nonexistent user")
	}
}
