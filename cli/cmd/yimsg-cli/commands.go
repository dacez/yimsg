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

// connectAuthedSession 拨号并用 sess 保存的 token 恢复会话。token 失效时提示
// 重新 login，而不是自动退化为静默失败。
func connectAuthedSession(sess account.Session, insecure bool) (*client.Client, error) {
	c, err := client.Dial(sess.ServerURL, insecure)
	if err != nil {
		return nil, err
	}
	if _, err := c.Authenticate(sess.Token); err != nil {
		c.Close()
		return nil, fmt.Errorf("token 鉴权失败（可能已过期，请重新执行 login）: %w", err)
	}
	return c, nil
}

// connectCurrent 读取当前账号并拨号鉴权，是绝大多数子命令的通用入口：调用方
// 不需要知道也不需要传自己的 uid，只需要先 login（或 switch-user）过一次。
func connectCurrent(dir string, insecure bool) (*client.Client, account.Session, error) {
	sess, err := account.LoadCurrent(dir)
	if err != nil {
		return nil, sess, err
	}
	c, err := connectAuthedSession(sess, insecure)
	if err != nil {
		return nil, sess, err
	}
	return c, sess, nil
}

// openCurrentStore 打开当前账号的本地同步库，并顺手把自己的 uid<->username
// 缓存一次（这个映射反正已知，不需要额外网络调用）。
func openCurrentStore(dir string, sess account.Session) (*store.Store, error) {
	st, err := store.Open(account.DataPath(dir, sess.Username))
	if err != nil {
		return nil, err
	}
	if err := st.CacheUser(sess.UID, sess.Username); err != nil {
		st.Close()
		return nil, err
	}
	return st, nil
}

// resolveUsername 把用户名解析为 uid：本地缓存命中直接返回，否则回源 search_user
// 并缓存结果。群没有用户名，不适用本函数，继续用数字 group_id。
func resolveUsername(c *client.Client, st *store.Store, username string) (int64, error) {
	if uid, ok, err := st.LookupUID(username); err != nil {
		return 0, err
	} else if ok {
		return uid, nil
	}
	resp, err := c.SearchUser(&pb.SearchUserRequest{Username: username})
	if err != nil {
		return 0, fmt.Errorf("查找用户名 %q 失败: %w", username, err)
	}
	profile := resp.GetProfile()
	if profile.GetUid() == 0 {
		return 0, fmt.Errorf("用户名 %q 不存在", username)
	}
	if err := st.CacheUser(profile.GetUid(), profile.GetUsername()); err != nil {
		return 0, err
	}
	return profile.GetUid(), nil
}

// resolveUsernameOffline 优先用本地缓存解析用户名，只有缓存未命中时才临时拨号，
// 让 history 之类的查询在会话对方已经打过交道的情况下保持纯本地、不发起网络请求。
func resolveUsernameOffline(sess account.Session, st *store.Store, username string, insecure bool) (int64, error) {
	if uid, ok, err := st.LookupUID(username); err != nil {
		return 0, err
	} else if ok {
		return uid, nil
	}
	c, err := connectAuthedSession(sess, insecure)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	return resolveUsername(c, st, username)
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
	// login 即切换为当前账号，后续命令无需再传任何身份信息。
	if err := account.SetCurrent(dir, sess); err != nil {
		return err
	}

	emitOK(map[string]any{"uid": sess.UID, "username": sess.Username, "dir": account.Dir(dir, sess.Username)})
	return nil
}

func cmdSwitchUser(args []string) error {
	fs := newFlagSet("switch-user")
	dirFlag := fs.String("dir", "", "根目录")
	username := fs.String("username", "", "要切换到的用户名（必须是本地已 login 过的账号）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if *username == "" {
		return fmt.Errorf("缺少 --username")
	}

	sess, err := account.FindByUsername(dir, *username)
	if err != nil {
		return err
	}
	if err := account.SetCurrent(dir, sess); err != nil {
		return err
	}

	emitOK(map[string]any{"uid": sess.UID, "username": sess.Username})
	return nil
}

func cmdCurrent(args []string) error {
	fs := newFlagSet("current")
	dirFlag := fs.String("dir", "", "根目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}

	sess, err := account.LoadCurrent(dir)
	if err != nil {
		return err
	}
	emitOK(map[string]any{"uid": sess.UID, "username": sess.Username, "server_url": sess.ServerURL})
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
	currentUID := int64(0)
	if cur, err := account.LoadCurrent(dir); err == nil {
		currentUID = cur.UID
	}

	out := make([]map[string]any, len(sessions))
	for i, s := range sessions {
		out[i] = map[string]any{
			"uid": s.UID, "username": s.Username, "server_url": s.ServerURL,
			"login_at": s.LoginAt, "current": s.UID == currentUID,
		}
	}
	emitOK(map[string]any{"accounts": out})
	return nil
}

func cmdSync(args []string) error {
	fs := newFlagSet("sync")
	dirFlag := fs.String("dir", "", "根目录")
	limit := fs.Int64("limit", 200, "单批同步条数")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}

	c, sess, err := connectCurrent(dir, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	st, err := openCurrentStore(dir, sess)
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
	toUser := fs.String("to-user", "", "接收方用户名")
	toGroup := fs.Int64("to-group", 0, "接收群 group_id（群没有用户名，只能用数字 ID）")
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
	if (*toUser != "") == (*toGroup > 0) {
		return fmt.Errorf("必须且只能指定 --to-user 或 --to-group 之一")
	}
	if (*text != "") == (*markdown != "") {
		return fmt.Errorf("必须且只能指定 --text 或 --markdown 之一")
	}

	c, sess, err := connectCurrent(dir, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	st, err := openCurrentStore(dir, sess)
	if err != nil {
		return err
	}
	defer st.Close()

	target := &pb.ConversationTarget{}
	if *toUser != "" {
		uid, err := resolveUsername(c, st, *toUser)
		if err != nil {
			return err
		}
		target.Kind = &pb.ConversationTarget_Uid{Uid: uid}
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
	withUser := fs.String("with-user", "", "会话对方用户名")
	withGroup := fs.Int64("with-group", 0, "会话群 group_id")
	afterSeq := fs.Int64("after-seq", 0, "只返回 seq 大于此值的消息")
	limit := fs.Int("limit", 50, "最多返回条数")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验（仅在需要临时解析未见过的用户名时用到）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if (*withUser != "") == (*withGroup > 0) {
		return fmt.Errorf("必须且只能指定 --with-user 或 --with-group 之一")
	}

	sess, err := account.LoadCurrent(dir)
	if err != nil {
		return err
	}
	st, err := openCurrentStore(dir, sess)
	if err != nil {
		return err
	}
	defer st.Close()

	var msgs []store.StoredMessage
	if *withUser != "" {
		peerUID, err := resolveUsernameOffline(sess, st, *withUser, *insecure)
		if err != nil {
			return err
		}
		msgs, err = st.HistoryWithUser(peerUID, *afterSeq, *limit)
		if err != nil {
			return err
		}
	} else {
		msgs, err = st.HistoryWithGroup(*withGroup, *afterSeq, *limit)
		if err != nil {
			return err
		}
	}

	out, err := storedMessagesJSON(st, msgs)
	if err != nil {
		return err
	}
	emitOK(map[string]any{"messages": out, "count": len(msgs)})
	return nil
}

// cmdPending 列出本地已同步、seq 大于给定游标的消息，默认排除本账号自己发出的消息；
// 起点 --after-seq 必须由调用方显式指定（调用方自行维护处理进度），不提供默认值。
func cmdPending(args []string) error {
	fs := newFlagSet("pending")
	dirFlag := fs.String("dir", "", "根目录")
	afterSeq := fs.Int64("after-seq", -1, "起始 seq（必填）；只返回 seq 大于此值的消息")
	limit := fs.Int("limit", 50, "最多返回条数")
	includeSelf := fs.Bool("include-self", false, "是否包含本账号自己发出的消息")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	if *afterSeq < 0 {
		return fmt.Errorf("缺少 --after-seq")
	}

	sess, err := account.LoadCurrent(dir)
	if err != nil {
		return err
	}
	st, err := openCurrentStore(dir, sess)
	if err != nil {
		return err
	}
	defer st.Close()

	since := *afterSeq

	msgs, err := st.Pending(sess.UID, since, *limit, *includeSelf)
	if err != nil {
		return err
	}

	maxSeq := since
	for _, m := range msgs {
		if m.Seq > maxSeq {
			maxSeq = m.Seq
		}
	}

	out, err := storedMessagesJSON(st, msgs)
	if err != nil {
		return err
	}
	emitOK(map[string]any{"messages": out, "count": len(msgs), "since": since, "max_seq": maxSeq})
	return nil
}

func cmdUserInfo(args []string) error {
	fs := newFlagSet("user-info")
	dirFlag := fs.String("dir", "", "根目录")
	usernames := fs.String("usernames", "", "逗号分隔的用户名列表")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	names, err := parseStringList(*usernames)
	if err != nil {
		return fmt.Errorf("--usernames: %w", err)
	}

	c, sess, err := connectCurrent(dir, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	st, err := openCurrentStore(dir, sess)
	if err != nil {
		return err
	}
	defer st.Close()

	out := make([]map[string]any, 0, len(names))
	for _, name := range names {
		resp, err := c.SearchUser(&pb.SearchUserRequest{Username: name})
		if err != nil {
			return fmt.Errorf("查询用户名 %q 失败: %w", name, err)
		}
		p := resp.GetProfile()
		if err := st.CacheUser(p.GetUid(), p.GetUsername()); err != nil {
			return err
		}
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
	groups := fs.String("groups", "", "逗号分隔的目标 group_id 列表")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	groupIDs, err := parseInt64List(*groups)
	if err != nil {
		return fmt.Errorf("--groups: %w", err)
	}

	c, _, err := connectCurrent(dir, *insecure)
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

// cmdContacts 列出好友 / 收藏群，并批量回源用户资料 / 群资料把 username（用户）
// 或 name（群）一并附上：Contact 本身只有 remark_name，不含 username，AI 之后要
// send/history 用的用户名靠这里一次性拿到，避免逐条再查一次。
func cmdContacts(args []string) error {
	fs := newFlagSet("contacts")
	dirFlag := fs.String("dir", "", "根目录")
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
	status, err := parseContactStatus(*statusFlag)
	if err != nil {
		return err
	}

	c, sess, err := connectCurrent(dir, *insecure)
	if err != nil {
		return err
	}
	defer c.Close()

	st, err := openCurrentStore(dir, sess)
	if err != nil {
		return err
	}
	defer st.Close()

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

	var userUIDs, groupIDs []int64
	for _, ct := range all {
		switch k := ct.GetTarget().GetKind().(type) {
		case *pb.ContactTarget_Uid:
			userUIDs = append(userUIDs, k.Uid)
		case *pb.ContactTarget_GroupId:
			groupIDs = append(groupIDs, k.GroupId)
		}
	}

	usernames := make(map[int64]string, len(userUIDs))
	if len(userUIDs) > 0 {
		resp, err := c.GetUserInfos(&pb.GetUserInfosRequest{Uids: userUIDs})
		if err != nil {
			return err
		}
		for _, p := range resp.GetProfiles() {
			usernames[p.GetUid()] = p.GetUsername()
			if err := st.CacheUser(p.GetUid(), p.GetUsername()); err != nil {
				return err
			}
		}
	}
	groupNames := make(map[int64]string, len(groupIDs))
	if len(groupIDs) > 0 {
		resp, err := c.GetGroupInfos(&pb.GetGroupInfosRequest{GroupIds: groupIDs})
		if err != nil {
			return err
		}
		for _, g := range resp.GetGroups() {
			groupNames[g.GetGroupId()] = g.GetName()
		}
	}

	out := make([]map[string]any, 0, len(all))
	for _, ct := range all {
		entry := map[string]any{"status": ct.GetStatus().String(), "seq": ct.GetSeq(), "remark_name": ct.GetRemarkName()}
		switch k := ct.GetTarget().GetKind().(type) {
		case *pb.ContactTarget_Uid:
			entry["kind"] = "user"
			entry["uid"] = k.Uid
			if name, ok := usernames[k.Uid]; ok {
				entry["username"] = name
			}
		case *pb.ContactTarget_GroupId:
			entry["kind"] = "group"
			entry["group_id"] = k.GroupId
			if name, ok := groupNames[k.GroupId]; ok {
				entry["name"] = name
			}
		case *pb.ContactTarget_OrgId:
			entry["kind"] = "org"
			entry["org_id"] = k.OrgId
		}
		out = append(out, entry)
	}
	emitOK(map[string]any{"contacts": out, "count": len(out)})
	return nil
}
