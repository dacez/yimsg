package service

import (
	"testing"
	"yimsg/server/internal/dal"
)

func TestRegisterSuccess(t *testing.T) {
	s := testState(t)
	resp := registerService(s, "r1", "alice", "pass123", "Alice")
	if !isOK(resp) {
		t.Fatalf("expected ok, got error: %s", errMsg(resp))
	}
	if resp.GetUid() <= 0 {
		t.Error("uid should be positive")
	}
}

func TestRegisterDuplicateUsername(t *testing.T) {
	s := testState(t)
	registerService(s, "r1", "alice", "pass123", "Alice")
	resp := registerService(s, "r2", "alice", "other", "Alice2")
	if isOK(resp) {
		t.Error("duplicate username should fail")
	}
	if errMsg(resp) != "username already exists" {
		t.Errorf("got error %q", errMsg(resp))
	}
}

func TestRegisterInitsContactVersion(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	// get_contacts should work immediately after registration
	resp := listContactsService(s, "r1", uid, dal.ContactListFilter{}, "", 200)
	if !isOK(resp) {
		t.Fatalf("get_contacts failed: %s", errMsg(resp))
	}
}

func TestLoginSuccess(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass123", "Alice")

	resp := loginService(s, "r1", "alice", "pass123")
	if !isOK(resp) {
		t.Fatalf("login failed: %s", errMsg(resp))
	}
	if resp.GetToken() == "" {
		t.Error("token should not be empty")
	}
	if resp.GetUid() <= 0 {
		t.Error("uid should be positive")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass123", "Alice")

	resp := loginService(s, "r1", "alice", "wrong")
	if isOK(resp) {
		t.Error("wrong password should fail")
	}
	if errMsg(resp) != "wrong password" {
		t.Errorf("got error %q", errMsg(resp))
	}
}

func TestLoginUserNotFound(t *testing.T) {
	s := testState(t)
	resp := loginService(s, "r1", "nonexistent", "pass")
	if isOK(resp) {
		t.Error("nonexistent user should fail")
	}
	if errMsg(resp) != "user not found" {
		t.Errorf("got error %q", errMsg(resp))
	}
}

func TestGetProfileSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := getUserInfosService(s, "r1", uid, []int64{uid})
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
	}
	if len(resp.GetProfiles()) == 0 {
		t.Fatal("profile should not be empty")
	}
	if resp.GetProfiles()[0].GetNickname() != "Alice" {
		t.Errorf("nickname = %q, want Alice", resp.GetProfiles()[0].GetNickname())
	}
}

func TestGetUserInfosNotFound(t *testing.T) {
	s := testState(t)
	resp := getUserInfosService(s, "r1", 0, []int64{9999})
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
	}
	if len(resp.GetProfiles()) != 0 {
		t.Errorf("nonexistent user should return empty profiles, got %d", len(resp.GetProfiles()))
	}
}

func TestUpdateUserInfoSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := updateUserInfoService(s, "r1", uid, "NewAlice", "avatar.jpg")
	if !isOK(resp) {
		t.Fatalf("update_user_info failed: %s", errMsg(resp))
	}

	profile := getUserInfosService(s, "r2", uid, []int64{uid})
	if len(profile.GetProfiles()) == 0 || profile.GetProfiles()[0].GetNickname() != "NewAlice" || profile.GetProfiles()[0].GetAvatar() != "avatar.jpg" {
		t.Errorf("profile not updated: %+v", profile.GetProfiles())
	}
}

func TestUpdatePasswordSuccess(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "oldpass", "Alice")

	resp := updatePasswordService(s, "r1", uid, "oldpass", "newpass")
	if !isOK(resp) {
		t.Fatalf("update_password failed: %s", errMsg(resp))
	}

	// New password works
	loginResp := loginService(s, "r2", "alice", "newpass")
	if !isOK(loginResp) {
		t.Error("login with new password should succeed")
	}

	// Old password fails
	loginResp = loginService(s, "r3", "alice", "oldpass")
	if isOK(loginResp) {
		t.Error("login with old password should fail")
	}
}

func TestUpdatePasswordWrongOld(t *testing.T) {
	s := testState(t)
	uid := registerUser(t, s, "alice", "pass", "Alice")

	resp := updatePasswordService(s, "r1", uid, "wrong", "newpass")
	if isOK(resp) {
		t.Error("wrong old password should fail")
	}
	if errMsg(resp) != "wrong old password" {
		t.Errorf("got error %q", errMsg(resp))
	}
}

func TestUpdatePasswordKicksSessions(t *testing.T) {
	s := testState(t)
	uid, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	// Verify token works
	authResp := authenticateTokenService(s, "r1", token)
	if !isOK(authResp) {
		t.Fatal("token should work before password change")
	}

	updatePasswordService(s, "r2", uid, "pass", "newpass")

	// Old token should be invalid
	authResp = authenticateTokenService(s, "r3", token)
	if isOK(authResp) {
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
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
	}
	if len(resp.GetProfiles()) != 2 {
		t.Fatalf("profiles count = %d, want 2", len(resp.GetProfiles()))
	}
	// pb.UserInfo 本身不携带 remark 字段（关系态数据不进入用户展示资料），
	// 由类型系统在编译期保证 get_user_infos 不会泄露备注，这里只需确认 bob 在结果中。
	found := false
	for _, p := range resp.GetProfiles() {
		if p.GetUid() == uidB {
			found = true
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
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
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
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
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
	if !isOK(resp) {
		t.Fatalf("get_user_infos failed: %s", errMsg(resp))
	}
	if len(resp.GetProfiles()) != 1 {
		t.Fatalf("profiles count = %d, want 1", len(resp.GetProfiles()))
	}
	// pb.UserInfo 本身不携带 remark 字段，陌生人自然也不会有备注（编译期保证）。
}

func TestSearchUserFound(t *testing.T) {
	s := testState(t)
	registerUser(t, s, "alice", "pass", "Alice")

	resp := searchUserService(s, "r1", 0, "alice")
	if !isOK(resp) {
		t.Fatalf("search failed: %s", errMsg(resp))
	}
	if resp.GetProfile() == nil {
		t.Fatal("profile should not be nil")
	}
	if resp.GetProfile().GetNickname() != "Alice" {
		t.Errorf("nickname = %q, want Alice", resp.GetProfile().GetNickname())
	}
}

func TestSearchUserNotFound(t *testing.T) {
	s := testState(t)
	resp := searchUserService(s, "r1", 0, "nonexistent")
	if !isOK(resp) {
		t.Fatalf("search should return ok even for not found")
	}
	if resp.GetProfile() != nil {
		t.Error("profile should be nil for nonexistent user")
	}
}
