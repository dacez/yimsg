package e2e

import "testing"

func TestRegister(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	resp := c.register(username, "pass1234", "Nick")
	if resp.UID == "" {
		t.Fatal("register should return a non-empty uid")
	}
}

func TestRegisterDuplicate(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	resp := c2.send(wsRequest{
		"action": "register", "username": username,
		"password": "pass1234", "nickname": "Nick2",
	})
	if resp.OK {
		t.Fatal("duplicate register should fail")
	}
}

func TestRegisterEmptyUsername(t *testing.T) {
	c := dial(t)
	resp := c.send(wsRequest{
		"action": "register", "username": "",
		"password": "pass1234", "nickname": "Nick",
	})
	if resp.OK {
		t.Fatal("register with empty username should fail")
	}
}

func TestLoginSuccess(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	resp := c2.login(username, "pass1234")
	if resp.UID == "" {
		t.Fatal("login should return uid")
	}
	if resp.Token == "" {
		t.Fatal("login should return token")
	}
	if resp.ClientConfig == nil {
		t.Fatal("login should return client_config")
	}
	if resp.ClientConfig.RecallWindowSeconds <= 0 {
		t.Fatalf("login should return positive recall_window_seconds, got %+v", resp.ClientConfig)
	}
}

func TestLoginWrongPassword(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	resp := c2.send(wsRequest{
		"action": "login", "username": username, "password": "wrongpass",
	})
	if resp.OK {
		t.Fatal("login with wrong password should fail")
	}
}

func TestLoginNonexistentUser(t *testing.T) {
	c := dial(t)
	resp := c.send(wsRequest{
		"action": "login", "username": uniqueName("auth"), "password": "pass1234",
	})
	if resp.OK {
		t.Fatal("login with nonexistent user should fail")
	}
}

func TestAuthenticate(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	loginResp := c2.login(username, "pass1234")

	c3 := dial(t)
	authResp := c3.authenticate(loginResp.Token)
	if authResp.UID == "" {
		t.Fatal("authenticate should return uid")
	}
	if authResp.UID != loginResp.UID {
		t.Fatalf("authenticate uid %s != login uid %s", authResp.UID, loginResp.UID)
	}
	if authResp.ClientConfig == nil {
		t.Fatal("authenticate should return client_config")
	}
	if authResp.ClientConfig.RecallWindowSeconds != loginResp.ClientConfig.RecallWindowSeconds {
		t.Fatalf("authenticate recall_window_seconds %d != login recall_window_seconds %d", authResp.ClientConfig.RecallWindowSeconds, loginResp.ClientConfig.RecallWindowSeconds)
	}
}

func TestAuthenticateInvalidToken(t *testing.T) {
	c := dial(t)
	resp := c.send(wsRequest{
		"action": "authenticate", "token": "invalid_token_abc123",
	})
	if resp.OK {
		t.Fatal("authenticate with invalid token should fail")
	}
}

func TestLogout(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.registerAndLogin(username, "pass1234", "Nick")
	token := c.token

	c.logout()

	// Old token should no longer work
	c2 := dial(t)
	resp := c2.send(wsRequest{"action": "authenticate", "token": token})
	if resp.OK {
		t.Fatal("authenticate with logged-out token should fail")
	}
}

func TestRequiresAuth(t *testing.T) {
	c := dial(t)
	resp := c.send(wsRequest{"action": "get_user_infos"})
	if resp.OK {
		t.Fatal("get_user_infos without auth should fail")
	}
}
