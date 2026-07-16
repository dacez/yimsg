package e2e

import (
	"testing"
	"yimsg/protocol/generated/go/pb"
)

func TestGetProfile(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "MyNick")

	resp := sendOK(c, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{c.uid}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.GetProfiles()[0].GetUsername() != username {
		t.Errorf("username = %q, want %q", resp.GetProfiles()[0].GetUsername(), username)
	}
	if resp.GetProfiles()[0].GetNickname() != "MyNick" {
		t.Errorf("nickname = %q, want %q", resp.GetProfiles()[0].GetNickname(), "MyNick")
	}
	if resp.GetProfiles()[0].GetUid() != c.uid {
		t.Errorf("uid = %d, want %d", resp.GetProfiles()[0].GetUid(), c.uid)
	}
}

func TestGetProfileOther(t *testing.T) {
	c1 := dial(t)
	u1 := uniqueName("user")
	c1.registerAndLogin(u1, "pass1234", "User1")

	c2 := dial(t)
	u2 := uniqueName("user")
	c2.registerAndLogin(u2, "pass1234", "User2")

	resp := sendOK(c1, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{c2.uid}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) == 0 {
		t.Fatal("get_user_infos for other user should return profiles")
	}
	if resp.GetProfiles()[0].GetUid() != c2.uid {
		t.Errorf("uid = %d, want %d", resp.GetProfiles()[0].GetUid(), c2.uid)
	}
	if resp.GetProfiles()[0].GetNickname() != "User2" {
		t.Errorf("nickname = %q, want %q", resp.GetProfiles()[0].GetNickname(), "User2")
	}
}

func TestUpdateNickname(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "OldNick")

	sendOK(c, "update_user_info", &pb.UpdateUserInfoRequest{Nickname: "NewNick"}, &pb.UpdateUserInfoResponse{})

	resp := sendOK(c, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{c.uid}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.GetProfiles()[0].GetNickname() != "NewNick" {
		t.Errorf("nickname = %q, want %q", resp.GetProfiles()[0].GetNickname(), "NewNick")
	}
}

func TestUpdateAvatar(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	avatarPath := "/uploads/avatar/test.png"
	sendOK(c, "update_user_info", &pb.UpdateUserInfoRequest{Avatar: avatarPath}, &pb.UpdateUserInfoResponse{})

	resp := sendOK(c, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{c.uid}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.GetProfiles()[0].GetAvatar() != avatarPath {
		t.Errorf("avatar = %q, want %q", resp.GetProfiles()[0].GetAvatar(), avatarPath)
	}
}

func TestUpdatePassword(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "oldpass", "Nick")

	sendOK(c, "update_password", &pb.UpdatePasswordRequest{OldPassword: "oldpass", NewPassword: "newpass"}, &pb.UpdatePasswordResponse{})

	// Old password should no longer work
	c2 := dial(t)
	sendErr(c2, "login", &pb.LoginRequest{Username: username, Password: "oldpass"}, &pb.LoginResponse{})

	// New password should work
	c3 := dial(t)
	c3.login(username, "newpass")
}

func TestUpdatePasswordWrongOld(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	sendErr(c, "update_password", &pb.UpdatePasswordRequest{OldPassword: "wrongold", NewPassword: "newpass"}, &pb.UpdatePasswordResponse{})
}

func TestSearchUserFound(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "SearchNick")

	resp := sendOK(c, "search_user", &pb.SearchUserRequest{Username: username}, &pb.SearchUserResponse{})
	if resp.GetProfile() == nil {
		t.Fatal("search_user should return profile for existing user")
	}
	if resp.GetProfile().GetUsername() != username {
		t.Errorf("username = %q, want %q", resp.GetProfile().GetUsername(), username)
	}
	if resp.GetProfile().GetNickname() != "SearchNick" {
		t.Errorf("nickname = %q, want %q", resp.GetProfile().GetNickname(), "SearchNick")
	}
}

func TestSearchUserNotFound(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	resp := sendOK(c, "search_user", &pb.SearchUserRequest{Username: "nonexistent_user_xyz"}, &pb.SearchUserResponse{})
	if resp.GetProfile() != nil {
		t.Fatal("search_user for nonexistent user should return nil profile")
	}
}

func TestGetUserInfos(t *testing.T) {
	c1 := dial(t)
	c1.registerAndLogin(uniqueName("user"), "pass1234", "Alice")

	c2 := dial(t)
	c2.registerAndLogin(uniqueName("user"), "pass1234", "Bob")

	resp := sendOK(c1, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{c1.uid, c2.uid}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) != 2 {
		t.Fatalf("expected 2 profiles, got %d", len(resp.GetProfiles()))
	}

	found := map[int64]bool{}
	for _, p := range resp.GetProfiles() {
		found[p.GetUid()] = true
	}
	if !found[c1.uid] {
		t.Errorf("missing profile for uid %d", c1.uid)
	}
	if !found[c2.uid] {
		t.Errorf("missing profile for uid %d", c2.uid)
	}
}

func TestGetUserInfosEmpty(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("user"), "pass1234", "Nick")

	resp := sendOK(c, "get_user_infos", &pb.GetUserInfosRequest{Uids: []int64{}}, &pb.GetUserInfosResponse{})
	if len(resp.GetProfiles()) != 0 {
		t.Fatalf("expected 0 profiles, got %d", len(resp.GetProfiles()))
	}
}
