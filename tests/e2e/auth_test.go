package e2e

import (
	"testing"
	"yimsg/internal/protocol/pb"
)

func TestRegister(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	resp := c.register(username, "pass1234", "Nick")
	if resp.GetUid() <= 0 {
		t.Fatal("register should return a non-empty uid")
	}
}

func TestRegisterDuplicate(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	resp := sendErr(c2, "register", &pb.RegisterRequest{
		Username: username, Password: "pass1234", Nickname: "Nick2",
	}, &pb.RegisterResponse{})
	_ = resp
}

func TestRegisterEmptyUsername(t *testing.T) {
	c := dial(t)
	sendErr(c, "register", &pb.RegisterRequest{
		Username: "", Password: "pass1234", Nickname: "Nick",
	}, &pb.RegisterResponse{})
}

func TestLoginSuccess(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	resp := c2.login(username, "pass1234")
	if resp.GetUid() <= 0 {
		t.Fatal("login should return uid")
	}
	if resp.GetToken() == "" {
		t.Fatal("login should return token")
	}
	if resp.GetClientConfig() == nil {
		t.Fatal("login should return client_config")
	}
	if resp.GetClientConfig().GetRecallWindowSeconds() <= 0 {
		t.Fatalf("login should return positive recall_window_seconds, got %+v", resp.GetClientConfig())
	}
}

func TestLoginWrongPassword(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	sendErr(c2, "login", &pb.LoginRequest{Username: username, Password: "wrongpass"}, &pb.LoginResponse{})
}

func TestLoginNonexistentUser(t *testing.T) {
	c := dial(t)
	sendErr(c, "login", &pb.LoginRequest{Username: uniqueName("auth"), Password: "pass1234"}, &pb.LoginResponse{})
}

func TestAuthenticate(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.register(username, "pass1234", "Nick")

	c2 := dial(t)
	loginResp := c2.login(username, "pass1234")

	c3 := dial(t)
	authResp := c3.authenticate(loginResp.GetToken())
	if authResp.GetUid() <= 0 {
		t.Fatal("authenticate should return uid")
	}
	if authResp.GetUid() != loginResp.GetUid() {
		t.Fatalf("authenticate uid %d != login uid %d", authResp.GetUid(), loginResp.GetUid())
	}
	if authResp.GetClientConfig() == nil {
		t.Fatal("authenticate should return client_config")
	}
	if authResp.GetClientConfig().GetRecallWindowSeconds() != loginResp.GetClientConfig().GetRecallWindowSeconds() {
		t.Fatalf("authenticate recall_window_seconds %d != login recall_window_seconds %d", authResp.GetClientConfig().GetRecallWindowSeconds(), loginResp.GetClientConfig().GetRecallWindowSeconds())
	}
}

func TestAuthenticateInvalidToken(t *testing.T) {
	c := dial(t)
	sendErr(c, "authenticate", &pb.AuthenticateRequest{Token: "invalid_token_abc123"}, &pb.AuthenticateResponse{})
}

func TestLogout(t *testing.T) {
	c := dial(t)
	username := uniqueName("auth")
	c.registerAndLogin(username, "pass1234", "Nick")
	token := c.token

	c.logout()

	// Old token should no longer work
	c2 := dial(t)
	sendErr(c2, "authenticate", &pb.AuthenticateRequest{Token: token}, &pb.AuthenticateResponse{})
}

func TestRequiresAuth(t *testing.T) {
	c := dial(t)
	sendErr(c, "get_user_infos", &pb.GetUserInfosRequest{}, &pb.GetUserInfosResponse{})
}
