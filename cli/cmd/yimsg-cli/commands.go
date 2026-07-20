package main

import (
	"fmt"
	"strings"
	"time"

	"yimsg/cli/account"
	"yimsg/cli/client"
	"yimsg/cli/msgid"
	"yimsg/cli/store"
	"yimsg/protocol/generated/go/pb"
)

// connectAuthed 读取本地登录态、拨号并用保存的 token 恢复会话。token 失效时
// 提示重新 login，而不是自动退化为静默失败。
func connectAuthed(dir string, uid int64, insecure bool) (*client.Client, account.Session, error) {
	sess, err := account.Load(dir, uid)
	if err != nil {
		return nil, sess, err
	}
	c, err := client.Dial(sess.ServerURL, insecure)
	if err != nil {
		return nil, sess, err
	}
	if _, err := c.Authenticate(sess.Token); err != nil {
		c.Close()
		return nil, sess, fmt.Errorf("token 鉴权失败（可能已过期，请重新执行 login）: %w", err)
	}
	return c, sess, nil
}

func openAccountStore(dir string, uid int64) (*store.Store, error) {
	return store.Open(account.DataPath(dir, uid))
}

func cmdLogin(args []string) error {
	fs := newFlagSet("login")
	dirFlag := fs.String("dir", "", "根目录")
	server := fs.String("server", "", "WebSocket 地址，例如 ws://127.0.0.1:8080/ws")
	username := fs.String("username", "", "用户名")
	password := fs.String("password", "", "密码；留空则从 stdin 读取一行")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验（自签名证书部署使用）")
	if err := fs.Parse(args); err != nil {
		return err
	}

	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if *server == "" {
		return fmt.Errorf("缺少 --server")
	}
	if *username == "" {
		return fmt.Errorf("缺少 --username")
	}
	pass, err := readPassword(*password)
	if err != nil {
		return err
	}

	c, err := client.Dial(*server, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	resp, err := c.Login(*username, pass)
	if err != nil {
		return err
	}

	sess := account.Session{
		UID:       resp.GetUid(),
		Username:  *username,
		Token:     resp.GetToken(),
		ServerURL: *server,
		LoginAt:   time.Now().UnixMilli(),
	}
	if err := account.Save(dir, sess); err != nil {
		return err
	}

	emitOK(map[string]any{"uid": sess.UID, "username": sess.Username, "dir": account.Dir(dir, sess.UID)})
	return nil
}

func cmdAccounts(args []string) error {
	fs := newFlagSet("accounts")
	dirFlag := fs.String("dir", "", "根目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}

	sessions, err := account.List(dir)
	if err != nil {
		return err
	}
	out := make([]map[string]any, len(sessions))
	for i, s := range sessions {
		out[i] = map[string]any{"uid": s.UID, "username": s.Username, "server_url": s.ServerURL, "login_at": s.LoginAt}
	}
	emitOK(map[string]any{"accounts": out})
	return nil
}

func cmdSync(args []string) error {
	fs := newFlagSet("sync")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	limit := fs.Int64("limit", 200, "单批同步条数")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}

	c, sess, err := connectAuthed(dir, *uid, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	st, err := openAccountStore(dir, *uid)
	if err != nil {
		return err
	}
	defer st.Close()

	lastSeq, err := st.LastSyncedSeq()
	if err != nil {
		return err
	}

	total := 0
	for {
		resp, err := c.SyncMessages(&pb.SyncMessagesRequest{LastSeq: lastSeq, Limit: *limit})
		if err != nil {
			return err
		}
		n, err := st.SaveMessages(sess.UID, resp.GetMessages())
		if err != nil {
			return err
		}
		total += n
		if resp.GetCursorSeq() > 0 {
			lastSeq = resp.GetCursorSeq()
			if err := st.SetLastSyncedSeq(lastSeq); err != nil {
				return err
			}
		}
		if !resp.GetHasMore() {
			break
		}
	}

	emitOK(map[string]any{"synced": total, "last_synced_seq": lastSeq})
	return nil
}

func cmdSend(args []string) error {
	fs := newFlagSet("send")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	toUser := fs.Int64("to-user", 0, "接收用户 uid")
	toGroup := fs.Int64("to-group", 0, "接收群 group_id")
	text := fs.String("text", "", "文本消息内容")
	markdown := fs.String("markdown", "", "Markdown 消息内容")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	if (*toUser > 0) == (*toGroup > 0) {
		return fmt.Errorf("必须且只能指定 --to-user 或 --to-group 之一")
	}
	if (*text != "") == (*markdown != "") {
		return fmt.Errorf("必须且只能指定 --text 或 --markdown 之一")
	}

	target := &pb.ConversationTarget{}
	if *toUser > 0 {
		target.Kind = &pb.ConversationTarget_Uid{Uid: *toUser}
	} else {
		target.Kind = &pb.ConversationTarget_GroupId{GroupId: *toGroup}
	}
	var msgType pb.MessageType
	var body *pb.MessageBody
	if *text != "" {
		msgType = pb.MessageType_MESSAGE_TYPE_TEXT
		body = &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: *text}}}
	} else {
		msgType = pb.MessageType_MESSAGE_TYPE_MARKDOWN
		body = &pb.MessageBody{Kind: &pb.MessageBody_Markdown{Markdown: &pb.MarkdownBody{Markdown: *markdown}}}
	}

	c, _, err := connectAuthed(dir, *uid, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	msgID := msgid.Generate()
	resp, err := c.SendMessage(&pb.SendMessageRequest{Target: target, MsgType: msgType, Body: body, MsgId: msgID})
	if err != nil {
		return err
	}

	emitOK(map[string]any{"seq": resp.GetSeq(), "msg_id": resp.GetMsgId()})
	return nil
}

func cmdHistory(args []string) error {
	fs := newFlagSet("history")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	withUser := fs.Int64("with-user", 0, "会话对方 uid")
	withGroup := fs.Int64("with-group", 0, "会话群 group_id")
	afterSeq := fs.Int64("after-seq", 0, "只返回 seq 大于此值的消息")
	limit := fs.Int("limit", 50, "最多返回条数")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	if (*withUser > 0) == (*withGroup > 0) {
		return fmt.Errorf("必须且只能指定 --with-user 或 --with-group 之一")
	}

	st, err := openAccountStore(dir, *uid)
	if err != nil {
		return err
	}
	defer st.Close()

	var msgs []store.StoredMessage
	if *withUser > 0 {
		msgs, err = st.HistoryWithUser(*withUser, *afterSeq, *limit)
	} else {
		msgs, err = st.HistoryWithGroup(*withGroup, *afterSeq, *limit)
	}
	if err != nil {
		return err
	}

	emitOK(map[string]any{"messages": storedMessagesJSON(msgs), "count": len(msgs)})
	return nil
}

// cmdPending 列出本地已同步、seq 大于给定游标的消息，默认排除本账号自己发出的消息、
// 默认起点为已记录的 ai-cursor，用于驱动"取新消息 -> 处理 -> 推进 ai-cursor"的自动回复轮询。
func cmdPending(args []string) error {
	fs := newFlagSet("pending")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	afterSeq := fs.Int64("after-seq", -1, "起始 seq；不传则使用已记录的 ai-cursor")
	limit := fs.Int("limit", 50, "最多返回条数")
	includeSelf := fs.Bool("include-self", false, "是否包含本账号自己发出的消息")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}

	st, err := openAccountStore(dir, *uid)
	if err != nil {
		return err
	}
	defer st.Close()

	since := *afterSeq
	if since < 0 {
		since, err = st.AICursor()
		if err != nil {
			return err
		}
	}

	msgs, err := st.Pending(*uid, since, *limit, *includeSelf)
	if err != nil {
		return err
	}

	maxSeq := since
	for _, m := range msgs {
		if m.Seq > maxSeq {
			maxSeq = m.Seq
		}
	}

	emitOK(map[string]any{"messages": storedMessagesJSON(msgs), "count": len(msgs), "since": since, "max_seq": maxSeq})
	return nil
}

func cmdAICursor(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("ai-cursor 需要子命令 get 或 set")
	}
	switch args[0] {
	case "get":
		return cmdAICursorGet(args[1:])
	case "set":
		return cmdAICursorSet(args[1:])
	default:
		return fmt.Errorf("未知 ai-cursor 子命令: %s", args[0])
	}
}

func cmdAICursorGet(args []string) error {
	fs := newFlagSet("ai-cursor get")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}

	st, err := openAccountStore(dir, *uid)
	if err != nil {
		return err
	}
	defer st.Close()

	seq, err := st.AICursor()
	if err != nil {
		return err
	}
	emitOK(map[string]any{"seq": seq})
	return nil
}

func cmdAICursorSet(args []string) error {
	fs := newFlagSet("ai-cursor set")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	seq := fs.Int64("seq", -1, "要记录的 seq")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	if *seq < 0 {
		return fmt.Errorf("缺少或非法的 --seq")
	}

	st, err := openAccountStore(dir, *uid)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.SetAICursor(*seq); err != nil {
		return err
	}
	emitOK(map[string]any{"seq": *seq})
	return nil
}

func cmdUserInfo(args []string) error {
	fs := newFlagSet("user-info")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	targets := fs.String("targets", "", "逗号分隔的目标 uid 列表")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	uids, err := parseInt64List(*targets)
	if err != nil {
		return fmt.Errorf("--targets: %w", err)
	}

	c, _, err := connectAuthed(dir, *uid, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	resp, err := c.GetUserInfos(&pb.GetUserInfosRequest{Uids: uids})
	if err != nil {
		return err
	}

	out := make([]map[string]any, 0, len(resp.GetProfiles()))
	for _, p := range resp.GetProfiles() {
		out = append(out, map[string]any{
			"uid": p.GetUid(), "username": p.GetUsername(), "nickname": p.GetNickname(), "avatar": p.GetAvatar(),
		})
	}
	emitOK(map[string]any{"users": out})
	return nil
}

func cmdGroupInfo(args []string) error {
	fs := newFlagSet("group-info")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	groups := fs.String("groups", "", "逗号分隔的目标 group_id 列表")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	groupIDs, err := parseInt64List(*groups)
	if err != nil {
		return fmt.Errorf("--groups: %w", err)
	}

	c, _, err := connectAuthed(dir, *uid, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	resp, err := c.GetGroupInfos(&pb.GetGroupInfosRequest{GroupIds: groupIDs})
	if err != nil {
		return err
	}

	out := make([]map[string]any, 0, len(resp.GetGroups()))
	for _, g := range resp.GetGroups() {
		out = append(out, map[string]any{
			"group_id": g.GetGroupId(), "name": g.GetName(), "avatar": g.GetAvatar(), "owner_uid": g.GetOwnerUid(),
		})
	}
	emitOK(map[string]any{"groups": out})
	return nil
}

func parseContactStatus(s string) (pb.ContactStatus, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "friend":
		return pb.ContactStatus_CONTACT_STATUS_FRIEND, nil
	case "pending_incoming":
		return pb.ContactStatus_CONTACT_STATUS_PENDING_INCOMING, nil
	case "pending_outgoing":
		return pb.ContactStatus_CONTACT_STATUS_PENDING_OUTGOING, nil
	default:
		return 0, fmt.Errorf("未知 --status: %s", s)
	}
}

func cmdContacts(args []string) error {
	fs := newFlagSet("contacts")
	dirFlag := fs.String("dir", "", "根目录")
	uid := fs.Int64("uid", 0, "账号 uid")
	statusFlag := fs.String("status", "friend", "friend|pending_incoming|pending_outgoing")
	limit := fs.Int64("limit", 100, "单批分页条数")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if err := requireUID(*uid); err != nil {
		return err
	}
	status, err := parseContactStatus(*statusFlag)
	if err != nil {
		return err
	}

	c, _, err := connectAuthed(dir, *uid, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	var all []*pb.Contact
	cursor := ""
	for {
		resp, err := c.GetContacts(&pb.GetContactsRequest{
			Status: &status,
			Page:   &pb.PageQuery{Cursor: cursor, Limit: *limit},
		})
		if err != nil {
			return err
		}
		all = append(all, resp.GetContacts()...)
		page := resp.GetPage()
		if page == nil || !page.GetHasMoreForward() || page.GetEndCursor() == "" {
			break
		}
		cursor = page.GetEndCursor()
	}

	out := make([]map[string]any, 0, len(all))
	for _, ct := range all {
		entry := map[string]any{"status": ct.GetStatus().String(), "seq": ct.GetSeq(), "remark_name": ct.GetRemarkName()}
		switch k := ct.GetTarget().GetKind().(type) {
		case *pb.ContactTarget_Uid:
			entry["kind"] = "user"
			entry["uid"] = k.Uid
		case *pb.ContactTarget_GroupId:
			entry["kind"] = "group"
			entry["group_id"] = k.GroupId
		case *pb.ContactTarget_OrgId:
			entry["kind"] = "org"
			entry["org_id"] = k.OrgId
		}
		out = append(out, entry)
	}
	emitOK(map[string]any{"contacts": out, "count": len(out)})
	return nil
}
