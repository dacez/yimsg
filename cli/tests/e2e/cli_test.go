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
// login 同时会把该账号设为当前账号。
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

// TestLoginSwitchUserAndCurrent 验证：login 自动把新账号设为当前账号、无需再传
// 用户名密码即可用 token 完成鉴权操作、switch-user 能在本地已登录账号之间切换、
// current 能查看当前账号。
func TestLoginSwitchUserAndCurrent(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)
	dir := newCLIDir(t)

	loginCLI(t, dir, userA, passA, uidA)
	cur := runCLIOK(t, "current", "--dir", dir)
	if cur.JSON["username"] != userA {
		t.Fatalf("current after login A = %v, want username=%s", cur.JSON, userA)
	}

	loginCLI(t, dir, userB, passB, uidB)
	cur = runCLIOK(t, "current", "--dir", dir)
	if cur.JSON["username"] != userB {
		t.Fatalf("current after login B = %v, want username=%s", cur.JSON, userB)
	}

	accounts := runCLIOK(t, "accounts", "--dir", dir)
	list, ok := accounts.JSON["accounts"].([]any)
	if !ok || len(list) != 2 {
		t.Fatalf("accounts = %v, want 2 entries", accounts.JSON["accounts"])
	}
	for _, item := range list {
		entry := item.(map[string]any)
		wantCurrent := entry["username"] == userB
		if entry["current"] != wantCurrent {
			t.Fatalf("accounts entry %v: current flag wrong, want current=%v for %s", entry, wantCurrent, userB)
		}
	}

	// 切回 A，且不需要再提供用户名密码或 uid——只有本地已 login 过的账号才能切换成功。
	runCLIOK(t, "switch-user", "--dir", dir, "--username", userA)
	cur = runCLIOK(t, "current", "--dir", dir)
	if cur.JSON["username"] != userA {
		t.Fatalf("current after switch-user A = %v, want username=%s", cur.JSON, userA)
	}

	// 不再传用户名密码或 uid，仅凭"当前账号"完成 sync（鉴权来自 session.json 保存的 token）。
	syncResp := runCLIOK(t, "sync", "--dir", dir)
	if jsonNumber(t, syncResp.JSON["synced"]) < 0 {
		t.Fatalf("unexpected sync response: %v", syncResp.JSON)
	}

	// 切换到本地未登录过的用户名应报错。
	runCLIErr(t, "switch-user", "--dir", dir, "--username", "nobody-has-logged-in-as-this")
}

// TestSendSyncHistoryPendingAICursor 端到端跑通"用用户名发消息 -> 同步到本地
// -> 按会话查历史 -> 按 AI 游标取待处理增量 -> 记录 / 查询 AI 游标"的完整链路，
// 全程不出现任何一方自己的 uid，人对人 / 人对群都用调用方能记住的标识
// （用户名 / group_id）。
func TestSendSyncHistoryPendingAICursor(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)

	group := dialRaw(t)
	group.login(userA, passA)
	groupID := group.createGroup(uniqueName("team"), uidB)

	dir := newCLIDir(t)
	loginCLI(t, dir, userA, passA, uidA)
	loginCLI(t, dir, userB, passB, uidB)

	// 以 A 的身份发消息：DM 用对方用户名，群消息只能用 group_id（群没有用户名）。
	runCLIOK(t, "switch-user", "--dir", dir, "--username", userA)
	sendDM := runCLIOK(t, "send", "--dir", dir, "--to-user", userB, "--text", "hello from A")
	dmSeq := jsonNumber(t, sendDM.JSON["seq"])
	if dmSeq <= 0 {
		t.Fatalf("send dm seq = %v", sendDM.JSON["seq"])
	}
	sendGroup := runCLIOK(t, "send", "--dir", dir, "--to-group", fmtUID(groupID), "--markdown", "**hello team**")
	if jsonNumber(t, sendGroup.JSON["seq"]) <= dmSeq {
		t.Fatalf("group message seq should be greater than dm seq: %v", sendGroup.JSON)
	}

	// 发消息时按用户名解析出的 uid 应该已经缓存在 A 本地，coverage 见下面的 to_username 断言。

	runCLIOK(t, "switch-user", "--dir", dir, "--username", userB)
	runCLIOK(t, "sync", "--dir", dir)

	// B 查询和 A 的单聊历史：B 事先没跟 A 打过交道，用户名要靠一次性回源 search_user
	// 解析（而不是要求调用方知道 A 的 uid），历史正文按 from_uid 推导出真正的会话对方。
	historyB := runCLIOK(t, "history", "--dir", dir, "--with-user", userA)
	msgs, ok := historyB.JSON["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("history with-user = %v, want 1 message", historyB.JSON["messages"])
	}
	first := msgs[0].(map[string]any)
	if body := first["body"].(map[string]any); body["text"] != "hello from A" {
		t.Fatalf("unexpected history body: %v", body)
	}
	if first["from_username"] != userA {
		t.Fatalf("history message from_username = %v, want %s", first["from_username"], userA)
	}

	// A 查询群聊历史应看到系统消息（建群）+ 自己发的 markdown 消息。
	runCLIOK(t, "switch-user", "--dir", dir, "--username", userA)
	runCLIOK(t, "sync", "--dir", dir)
	historyGroup := runCLIOK(t, "history", "--dir", dir, "--with-group", fmtUID(groupID))
	groupMsgs := historyGroup.JSON["messages"].([]any)
	if len(groupMsgs) != 2 {
		t.Fatalf("history with-group count = %d, want 2: %v", len(groupMsgs), groupMsgs)
	}

	// pending / ai-cursor 都对"当前账号"操作，切回 B。
	runCLIOK(t, "switch-user", "--dir", dir, "--username", userB)

	// pending 默认排除自己发出的消息：B 自己一条都没发，三条（建群系统消息 from_uid=0、
	// A 发的 DM、A 发的群消息）的 from_uid 都不是 B，因此全部保留。
	pendingB := runCLIOK(t, "pending", "--dir", dir)
	pendingMsgs := pendingB.JSON["messages"].([]any)
	if len(pendingMsgs) != 3 {
		t.Fatalf("pending(exclude self) count = %d, want 3: %v", len(pendingMsgs), pendingMsgs)
	}
	maxSeq := jsonNumber(t, pendingB.JSON["max_seq"])

	// 记录 AI 游标为本轮已处理到的最大 seq，下次 pending 应为空。
	runCLIOK(t, "ai-cursor", "set", "--dir", dir, "--seq", fmtUID(maxSeq))
	cursorGet := runCLIOK(t, "ai-cursor", "get", "--dir", dir)
	if jsonNumber(t, cursorGet.JSON["seq"]) != maxSeq {
		t.Fatalf("ai-cursor get = %v, want %d", cursorGet.JSON["seq"], maxSeq)
	}

	pendingAfterCursor := runCLIOK(t, "pending", "--dir", dir)
	if got := pendingAfterCursor.JSON["messages"]; got != nil {
		if arr, ok := got.([]any); !ok || len(arr) != 0 {
			t.Fatalf("pending after advancing ai-cursor should be empty, got %v", got)
		}
	}
}

// TestUserInfoGroupInfoContacts 验证 user-info（按用户名查询）/ group-info（按
// group_id 查询）/ contacts（好友 / 收藏群列表，用户条目应带上 username）。
func TestUserInfoGroupInfoContacts(t *testing.T) {
	uidA, uidB, userA, userB, passA, passB := setupFriendPair(t)

	group := dialRaw(t)
	group.login(userA, passA)
	groupName := uniqueName("squad")
	groupID := group.createGroup(groupName, uidB)

	dir := newCLIDir(t)
	loginCLI(t, dir, userA, passA, uidA)
	loginCLI(t, dir, userB, passB, uidB)
	runCLIOK(t, "switch-user", "--dir", dir, "--username", userB)

	userInfo := runCLIOK(t, "user-info", "--dir", dir, "--usernames", userA)
	users := userInfo.JSON["users"].([]any)
	if len(users) != 1 || users[0].(map[string]any)["username"] != userA {
		t.Fatalf("user-info = %v, want username=%s", users, userA)
	}

	runCLIOK(t, "switch-user", "--dir", dir, "--username", userA)
	groupInfo := runCLIOK(t, "group-info", "--dir", dir, "--groups", fmtUID(groupID))
	groups := groupInfo.JSON["groups"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["name"] != groupName {
		t.Fatalf("group-info = %v, want name=%s", groups, groupName)
	}

	contacts := runCLIOK(t, "contacts", "--dir", dir)
	contactList := contacts.JSON["contacts"].([]any)
	found := false
	for _, item := range contactList {
		entry := item.(map[string]any)
		if entry["kind"] == "user" && entry["username"] == userB {
			found = true
		}
	}
	if !found {
		t.Fatalf("contacts of A should include B (with username) as friend: %v", contactList)
	}
}

// TestCLIRejectsInvalidArguments 验证互斥参数、缺失必填参数、未登录/未选择当前
// 账号在本地就被拒绝（history 的目标解析除外，其它均不需要连服务端）。
func TestCLIRejectsInvalidArguments(t *testing.T) {
	dir := newCLIDir(t)

	runCLIErr(t, "current", "--dir", dir)
	runCLIErr(t, "switch-user", "--dir", dir, "--username", "nobody")
	runCLIErr(t, "send", "--dir", dir, "--text", "hi")
	runCLIErr(t, "send", "--dir", dir, "--to-user", "alice", "--to-group", "3", "--text", "hi")
	runCLIErr(t, "send", "--dir", dir, "--to-user", "alice", "--text", "hi", "--markdown", "hi")
	runCLIErr(t, "history", "--dir", dir)
	runCLIErr(t, "sync", "--dir", dir)
}

// TestDefaultDirUnderCWD 验证 --dir 与 YIMSG_CLI_DIR 都缺省时，CLI 默认使用
// 当前工作目录下的 cli_data，且目录不存在时自动创建。
func TestDefaultDirUnderCWD(t *testing.T) {
	uidA, _, userA, _, passA, _ := setupFriendPair(t)
	workDir := newCLIDir(t)

	if _, err := os.Stat(filepath.Join(workDir, "cli_data")); err == nil {
		t.Fatalf("cli_data should not exist before the first call")
	}

	r := runCLIInOK(t, workDir, "login", "--server", wsURL, "--insecure",
		"--username", userA, "--password", passA)
	if got := jsonNumber(t, r.JSON["uid"]); got != uidA {
		t.Fatalf("login uid = %d, want %d", got, uidA)
	}

	sessionPath := filepath.Join(workDir, "cli_data", fmtUID(uidA), "session.json")
	if _, err := os.Stat(sessionPath); err != nil {
		t.Fatalf("expected session.json under ./cli_data (relative to cwd): %v", err)
	}

	// 之后同一工作目录下的命令，同样不传 --dir 也应该找到刚才登录的账号。
	cur := runCLIInOK(t, workDir, "current")
	if cur.JSON["username"] != userA {
		t.Fatalf("current (default dir) = %v, want username=%s", cur.JSON, userA)
	}
}
