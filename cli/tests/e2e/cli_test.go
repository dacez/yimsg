package e2e

import (
	"os"
	"path/filepath"
	"testing"
)

func newCLIDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "yimsg-cli-e2e-dir")
	if err != nil {
		t.Fatalf("mkdir cli dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// login 通过实际 yimsg-cli 二进制登录并保存 token，返回其 uid（应等于 wantUID）。
func loginCLI(t *testing.T, dir, username, password string, wantUID int64) {
	t.Helper()
	r := runCLIOK(t, "login", "--dir", dir, "--server", wsURL, "--insecure",
		"--username", username, "--password", password)
	if got := jsonNumber(t, r.JSON["uid"]); got != wantUID {
		t.Fatalf("login uid = %d, want %d", got, wantUID)
	}
	// session.json 必须落在 <dir>/<uid>/ 下（二级目录固定为 uid）。
	if _, err := os.Stat(filepath.Join(dir, fmtUID(wantUID), "session.json")); err != nil {
		t.Fatalf("session.json not found under account dir: %v", err)
	}
}

// TestLoginPersistsTokenForReuse 验证 login 落盘后，无需再次提供用户名密码，
// 后续命令仅凭 --dir/--uid 即可完成鉴权操作（例如 sync）。
func TestLoginPersistsTokenForReuse(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)
	dir := newCLIDir(t)

	loginCLI(t, dir, userA, passA, uidA)
	loginCLI(t, dir, userB, passB, uidB)

	accounts := runCLIOK(t, "accounts", "--dir", dir)
	list, ok := accounts.JSON["accounts"].([]any)
	if !ok || len(list) != 2 {
		t.Fatalf("accounts = %v, want 2 entries", accounts.JSON["accounts"])
	}

	// 不再传用户名密码，仅凭本地保存的 token 完成 sync（鉴权来自 session.json）。
	syncResp := runCLIOK(t, "sync", "--dir", dir, "--uid", fmtUID(uidA))
	if jsonNumber(t, syncResp.JSON["synced"]) < 0 {
		t.Fatalf("unexpected sync response: %v", syncResp.JSON)
	}
}

// TestSendSyncHistoryPendingAICursor 端到端跑通"发消息 -> 同步到本地 -> 按会话查历史
// -> 按 AI 游标取待处理增量 -> 记录 / 查询 AI 游标"的完整链路，这是 AI 自动回复要用到的核心路径。
func TestSendSyncHistoryPendingAICursor(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)

	group := dialRaw(t)
	group.login(userA, passA)
	groupID := group.createGroup(uniqueName("team"), uidB)

	dir := newCLIDir(t)
	loginCLI(t, dir, userA, passA, uidA)
	loginCLI(t, dir, userB, passB, uidB)

	sendDM := runCLIOK(t, "send", "--dir", dir, "--uid", fmtUID(uidA),
		"--to-user", fmtUID(uidB), "--text", "hello from A")
	dmSeq := jsonNumber(t, sendDM.JSON["seq"])
	if dmSeq <= 0 {
		t.Fatalf("send dm seq = %v", sendDM.JSON["seq"])
	}

	sendGroup := runCLIOK(t, "send", "--dir", dir, "--uid", fmtUID(uidA),
		"--to-group", fmtUID(groupID), "--markdown", "**hello team**")
	if jsonNumber(t, sendGroup.JSON["seq"]) <= dmSeq {
		t.Fatalf("group message seq should be greater than dm seq: %v", sendGroup.JSON)
	}

	runCLIOK(t, "sync", "--dir", dir, "--uid", fmtUID(uidB))
	runCLIOK(t, "sync", "--dir", dir, "--uid", fmtUID(uidA))

	// B 查询和 A 的单聊历史：会话对方推导必须正确（B 收件箱里这条消息的
	// target.uid 字面量是 B 自己，只有结合 from_uid 才能得到 A）。
	historyB := runCLIOK(t, "history", "--dir", dir, "--uid", fmtUID(uidB), "--with-user", fmtUID(uidA))
	msgs, ok := historyB.JSON["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("history with-user = %v, want 1 message", historyB.JSON["messages"])
	}
	first := msgs[0].(map[string]any)
	if body := first["body"].(map[string]any); body["text"] != "hello from A" {
		t.Fatalf("unexpected history body: %v", body)
	}

	// A 查询群聊历史应看到系统消息（建群）+ 自己发的 markdown 消息。
	historyGroup := runCLIOK(t, "history", "--dir", dir, "--uid", fmtUID(uidA), "--with-group", fmtUID(groupID))
	groupMsgs := historyGroup.JSON["messages"].([]any)
	if len(groupMsgs) != 2 {
		t.Fatalf("history with-group count = %d, want 2: %v", len(groupMsgs), groupMsgs)
	}

	// pending 默认排除自己发出的消息：B 自己一条都没发，三条（建群系统消息 from_uid=0、
	// A 发的 DM、A 发的群消息）的 from_uid 都不是 B，因此全部保留。
	pendingB := runCLIOK(t, "pending", "--dir", dir, "--uid", fmtUID(uidB))
	pendingMsgs := pendingB.JSON["messages"].([]any)
	if len(pendingMsgs) != 3 {
		t.Fatalf("pending(exclude self) count = %d, want 3: %v", len(pendingMsgs), pendingMsgs)
	}
	maxSeq := jsonNumber(t, pendingB.JSON["max_seq"])

	// 记录 AI 游标为本轮已处理到的最大 seq，下次 pending 应为空。
	runCLIOK(t, "ai-cursor", "set", "--dir", dir, "--uid", fmtUID(uidB), "--seq", fmtUID(maxSeq))
	cursorGet := runCLIOK(t, "ai-cursor", "get", "--dir", dir, "--uid", fmtUID(uidB))
	if jsonNumber(t, cursorGet.JSON["seq"]) != maxSeq {
		t.Fatalf("ai-cursor get = %v, want %d", cursorGet.JSON["seq"], maxSeq)
	}

	pendingAfterCursor := runCLIOK(t, "pending", "--dir", dir, "--uid", fmtUID(uidB))
	if got := pendingAfterCursor.JSON["messages"]; got != nil {
		if arr, ok := got.([]any); !ok || len(arr) != 0 {
			t.Fatalf("pending after advancing ai-cursor should be empty, got %v", got)
		}
	}
}

// TestUserInfoGroupInfoContacts 验证 user-info / group-info / contacts 三个查询类命令。
func TestUserInfoGroupInfoContacts(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)

	group := dialRaw(t)
	group.login(userA, passA)
	groupName := uniqueName("squad")
	groupID := group.createGroup(groupName, uidB)

	dir := newCLIDir(t)
	loginCLI(t, dir, userA, passA, uidA)
	loginCLI(t, dir, userB, passB, uidB)

	userInfo := runCLIOK(t, "user-info", "--dir", dir, "--uid", fmtUID(uidB), "--targets", fmtUID(uidA))
	users := userInfo.JSON["users"].([]any)
	if len(users) != 1 || users[0].(map[string]any)["username"] != userA {
		t.Fatalf("user-info = %v, want username=%s", users, userA)
	}

	groupInfo := runCLIOK(t, "group-info", "--dir", dir, "--uid", fmtUID(uidA), "--groups", fmtUID(groupID))
	groups := groupInfo.JSON["groups"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["name"] != groupName {
		t.Fatalf("group-info = %v, want name=%s", groups, groupName)
	}

	contacts := runCLIOK(t, "contacts", "--dir", dir, "--uid", fmtUID(uidA))
	contactList := contacts.JSON["contacts"].([]any)
	found := false
	for _, item := range contactList {
		entry := item.(map[string]any)
		if entry["kind"] == "user" && jsonNumber(t, entry["uid"]) == uidB {
			found = true
		}
	}
	if !found {
		t.Fatalf("contacts of A should include B as friend: %v", contactList)
	}
}

// TestCLIRejectsInvalidArguments 验证互斥参数与缺失必填参数在本地就被拒绝，不需要连服务端。
func TestCLIRejectsInvalidArguments(t *testing.T) {
	dir := newCLIDir(t)

	runCLIErr(t, "accounts")
	runCLIErr(t, "send", "--dir", dir, "--uid", "1", "--text", "hi")
	runCLIErr(t, "send", "--dir", dir, "--uid", "1", "--to-user", "2", "--to-group", "3", "--text", "hi")
	runCLIErr(t, "send", "--dir", dir, "--uid", "1", "--to-user", "2", "--text", "hi", "--markdown", "hi")
	runCLIErr(t, "history", "--dir", dir, "--uid", "1")
	runCLIErr(t, "sync", "--dir", dir, "--uid", "999999999")
}
