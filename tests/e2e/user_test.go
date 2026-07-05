package e2e

import "testing"

func TestGetProfile(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "MyNick")

	resp := c.sendOK(wsRequest{"action": "get_user_infos", "uids": []string{c.uid}})
	if len(resp.Profiles) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.Profiles[0].Username != username {
		t.Errorf("username = %q, want %q", resp.Profiles[0].Username, username)
	}
	if resp.Profiles[0].Nickname != "MyNick" {
		t.Errorf("nickname = %q, want %q", resp.Profiles[0].Nickname, "MyNick")
	}
	if resp.Profiles[0].UID != c.uid {
		t.Errorf("uid = %q, want %q", resp.Profiles[0].UID, c.uid)
	}
}

func TestGetProfileOther(t *testing.T) {
	c1 := dial(t)
	u1 := uniqueName("user")
	c1.registerAndLogin(u1, "pass1234", "User1")

	c2 := dial(t)
	u2 := uniqueName("user")
	c2.registerAndLogin(u2, "pass1234", "User2")

	resp := c1.sendOK(wsRequest{"action": "get_user_infos", "uids": []string{c2.uid}})
	if len(resp.Profiles) == 0 {
		t.Fatal("get_user_infos for other user should return profiles")
	}
	if resp.Profiles[0].UID != c2.uid {
		t.Errorf("uid = %q, want %q", resp.Profiles[0].UID, c2.uid)
	}
	if resp.Profiles[0].Nickname != "User2" {
		t.Errorf("nickname = %q, want %q", resp.Profiles[0].Nickname, "User2")
	}
}

func TestUpdateNickname(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "OldNick")

	c.sendOK(wsRequest{"action": "update_user_info", "nickname": "NewNick"})

	resp := c.sendOK(wsRequest{"action": "get_user_infos", "uids": []string{c.uid}})
	if len(resp.Profiles) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.Profiles[0].Nickname != "NewNick" {
		t.Errorf("nickname = %q, want %q", resp.Profiles[0].Nickname, "NewNick")
	}
}

func TestUpdateAvatar(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	avatarPath := "/uploads/avatar/test.png"
	c.sendOK(wsRequest{"action": "update_user_info", "avatar": avatarPath})

	resp := c.sendOK(wsRequest{"action": "get_user_infos", "uids": []string{c.uid}})
	if len(resp.Profiles) == 0 {
		t.Fatal("get_user_infos should return profiles")
	}
	if resp.Profiles[0].Avatar != avatarPath {
		t.Errorf("avatar = %q, want %q", resp.Profiles[0].Avatar, avatarPath)
	}
}

func TestUpdatePassword(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "oldpass", "Nick")

	c.sendOK(wsRequest{
		"action":       "update_password",
		"old_password": "oldpass",
		"new_password": "newpass",
	})

	// Old password should no longer work
	c2 := dial(t)
	resp := c2.send(wsRequest{
		"action": "login", "username": username, "password": "oldpass",
	})
	if resp.OK {
		t.Fatal("login with old password should fail after password change")
	}

	// New password should work
	c3 := dial(t)
	c3.login(username, "newpass")
}

func TestUpdatePasswordWrongOld(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	resp := c.send(wsRequest{
		"action":       "update_password",
		"old_password": "wrongold",
		"new_password": "newpass",
	})
	if resp.OK {
		t.Fatal("update_password with wrong old_password should fail")
	}
}

func TestSearchUserFound(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "SearchNick")

	resp := c.sendOK(wsRequest{"action": "search_user", "username": username})
	if resp.Profile == nil {
		t.Fatal("search_user should return profile for existing user")
	}
	if resp.Profile.Username != username {
		t.Errorf("username = %q, want %q", resp.Profile.Username, username)
	}
	if resp.Profile.Nickname != "SearchNick" {
		t.Errorf("nickname = %q, want %q", resp.Profile.Nickname, "SearchNick")
	}
}

func TestSearchUserNotFound(t *testing.T) {
	c := dial(t)
	username := uniqueName("user")
	c.registerAndLogin(username, "pass1234", "Nick")

	resp := c.sendOK(wsRequest{"action": "search_user", "username": "nonexistent_user_xyz"})
	if resp.Profile != nil {
		t.Fatal("search_user for nonexistent user should return nil profile")
	}
}

func TestGetUserInfos(t *testing.T) {
	c1 := dial(t)
	c1.registerAndLogin(uniqueName("user"), "pass1234", "Alice")

	c2 := dial(t)
	c2.registerAndLogin(uniqueName("user"), "pass1234", "Bob")

	resp := c1.sendOK(wsRequest{
		"action": "get_user_infos",
		"uids":   []string{c1.uid, c2.uid},
	})
	if len(resp.Profiles) != 2 {
		t.Fatalf("expected 2 profiles, got %d", len(resp.Profiles))
	}

	found := map[string]bool{}
	for _, p := range resp.Profiles {
		found[p.UID] = true
	}
	if !found[c1.uid] {
		t.Errorf("missing profile for uid %s", c1.uid)
	}
	if !found[c2.uid] {
		t.Errorf("missing profile for uid %s", c2.uid)
	}
}

func TestGetUserInfosEmpty(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("user"), "pass1234", "Nick")

	resp := c.sendOK(wsRequest{
		"action": "get_user_infos",
		"uids":   []string{},
	})
	if resp.Profiles == nil {
		// Accept nil as empty
		return
	}
	if len(resp.Profiles) != 0 {
		t.Fatalf("expected 0 profiles, got %d", len(resp.Profiles))
	}
}
