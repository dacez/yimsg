// seed-data 清除所有数据并构建测试数据（使用 service 层接口）。
//
// 用法:
//
//	go run ./tools/cmd/seed-data [-config config.toml]
//
// 构建内容:
//   - 1000 个用户 User1..User1000，nickname 用户1..用户1000，密码 123456
//   - User1 与所有其他用户互为好友
//   - 大群（所有 1000 用户），100 条消息
//   - 中群（User1-User4），10000 条消息
//   - User1 分别与 User2-User1000 各 2 条单聊消息
//   - User1 收藏大群、中群到通讯录（通讯录"群"分组样例）
//   - 组织"腾讯科技有限公司广州研发中心"：公司领导 / 研发部（后台组、前端组）/ 行政部，
//     User1 总经理排第一、User2 副总排第二；User3 一人多岗（公司领导沉底、研发部 rank=1）
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/msgid"
	"yimsg/internal/plugin"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/service"
	"yimsg/internal/shard"
	"yimsg/internal/taskqueue"
)

const (
	userCount      = 1000
	password       = "123456"
	smallGroupN    = 4
	bigGroupMsgN   = 100
	smallGroupMsgN = 10000
	dmMsgN         = 2
)

func baseInfo(uid int64) *service.BaseInfo {
	return &service.BaseInfo{UID: uid, RequestID: 1}
}

func ok(base *pb.BaseResponse) bool {
	return base != nil && base.Code == pb.ErrorCode_ERROR_OK
}

func main() {
	configPath := flag.String("config", "config.toml", "配置文件路径")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// Step 0: 关闭服务器 → 清除数据
	fmt.Println("=== Step 0: 关闭服务器并清除数据 ===")
	stopServer(cfg.Server.Port)
	if err := os.RemoveAll(cfg.Database.DataDir); err != nil {
		log.Fatalf("删除数据目录失败: %v", err)
	}
	if err := os.MkdirAll(cfg.Database.DataDir, 0o755); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	if err := os.MkdirAll(cfg.Media.UploadDir, 0o755); err != nil {
		log.Fatalf("创建上传目录失败: %v", err)
	}
	fmt.Println("  数据目录已清除并重建")

	db, err := shard.Open(cfg.Database.DataDir, cfg.Database.ShardCount, dal.Schemas())
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer db.Close()

	state := service.NewAppState(db, cfg, plugin.NewRegistry())
	// seed 不持久化任务，改用同步模式：每次发送返回前 fanout 已写入完成。
	tasks, err := taskqueue.Open("")
	if err != nil {
		log.Fatalf("打开任务队列失败: %v", err)
	}
	state.UseTaskQueue(tasks)
	tasks.SetSync()

	// Step 1: 注册 1000 个用户
	fmt.Printf("\n=== Step 1: 注册 %d 个用户 ===\n", userCount)
	t0 := time.Now()
	uids := make([]int64, userCount)
	usernames := make([]string, userCount)
	for i := 0; i < userCount; i++ {
		usernames[i] = fmt.Sprintf("User%d", i+1)
		nickname := fmt.Sprintf("用户%d", i+1)
		resp := state.Register(baseInfo(0), &pb.RegisterRequest{Username: usernames[i], Password: password, Nickname: nickname})
		if !ok(resp.GetBase()) {
			log.Fatalf("注册 %s 失败: %s", usernames[i], resp.GetBase().GetMsg())
		}
		uids[i] = resp.GetUid()
		if (i+1)%1000 == 0 {
			fmt.Printf("  %d/%d (%v)\n", i+1, userCount, time.Since(t0).Round(time.Millisecond))
		}
	}
	fmt.Printf("  注册完成，UID 范围: %d .. %d (%v)\n", uids[0], uids[userCount-1], time.Since(t0).Round(time.Millisecond))

	uid1 := uids[0]

	// Step 2: User1 与所有其他用户互为好友（AddFriend + AcceptFriend）
	fmt.Println("\n=== Step 2: User1 与所有用户互为好友 ===")
	t0 = time.Now()
	for i := 1; i < userCount; i++ {
		resp := state.AddFriend(baseInfo(uid1), &pb.AddFriendRequest{FriendUid: uids[i]})
		if !ok(resp.GetBase()) {
			log.Fatalf("AddFriend User1→User%d: %s", i+1, resp.GetBase().GetMsg())
		}
		resp2 := state.AcceptFriend(baseInfo(uids[i]), &pb.AcceptFriendRequest{FriendUid: uid1})
		if !ok(resp2.GetBase()) {
			log.Fatalf("AcceptFriend User%d: %s", i+1, resp2.GetBase().GetMsg())
		}
		if i%1000 == 0 {
			fmt.Printf("  %d/%d (%v)\n", i, userCount-1, time.Since(t0).Round(time.Millisecond))
		}
	}
	fmt.Printf("  好友关系完成，共 %d 组 (%v)\n", userCount-1, time.Since(t0).Round(time.Millisecond))

	// Step 3: 创建大群（1000 人）并发送 1000 条消息（每人一条），每条扇出写入所有成员收件箱
	fmt.Printf("\n=== Step 3: 大群（%d 人）+ %d 条消息 ===\n", userCount, bigGroupMsgN)
	t0 = time.Now()
	resp := state.CreateGroup(baseInfo(uid1), &pb.CreateGroupRequest{Name: "大群", MemberUids: uids})
	if !ok(resp.GetBase()) {
		log.Fatalf("创建大群失败: %s", resp.GetBase().GetMsg())
	}
	bigGroupID := resp.GetGroupId()
	fmt.Printf("  大群已创建 group_id=%d (%v)\n", bigGroupID, time.Since(t0).Round(time.Millisecond))

	fmt.Printf("  发送 %d 条消息（每条扇出到 %d 人）...\n", bigGroupMsgN, userCount)
	for i := 0; i < bigGroupMsgN; i++ {
		senderIdx := i % userCount
		senderUID := uids[senderIdx]
		content := fmt.Sprintf("大群_%s_%d", usernames[senderIdx], i+1)
		req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: pbGroupTarget(bigGroupID), MsgType: pb.MessageType(dal.MsgText), Body: pbTextBody(content)}
		sresp := state.SendMessage(baseInfo(senderUID), req)
		if !ok(sresp.GetBase()) {
			log.Fatalf("大群消息 %d 失败: %s", i+1, sresp.GetBase().GetMsg())
		}
		if (i+1)%100 == 0 {
			fmt.Printf("  %d/%d (%v)\n", i+1, bigGroupMsgN, time.Since(t0).Round(time.Millisecond))
		}
	}
	fmt.Printf("  大群消息完成 (%v)\n", time.Since(t0).Round(time.Millisecond))

	// Step 4: 创建中群（User1-User4）并发送 10000 条消息
	fmt.Println("\n=== Step 4: 中群（User1-User4）+ 10000 条消息 ===")
	t0 = time.Now()
	resp = state.CreateGroup(baseInfo(uid1), &pb.CreateGroupRequest{Name: "中群", MemberUids: uids[:smallGroupN]})
	if !ok(resp.GetBase()) {
		log.Fatalf("创建中群失败: %s", resp.GetBase().GetMsg())
	}
	smallGroupID := resp.GetGroupId()
	fmt.Printf("  中群已创建 group_id=%d\n", smallGroupID)

	for i := 0; i < smallGroupMsgN; i++ {
		senderIdx := i % smallGroupN
		senderUID := uids[senderIdx]
		content := fmt.Sprintf("中群_%s_%d", usernames[senderIdx], i+1)
		req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: pbGroupTarget(smallGroupID), MsgType: pb.MessageType(dal.MsgText), Body: pbTextBody(content)}
		sresp := state.SendMessage(baseInfo(senderUID), req)
		if !ok(sresp.GetBase()) {
			log.Fatalf("中群消息 %d 失败: %s", i+1, sresp.GetBase().GetMsg())
		}
		if (i+1)%1000 == 0 {
			fmt.Printf("  %d/%d (%v)\n", i+1, smallGroupMsgN, time.Since(t0).Round(time.Millisecond))
		}
	}
	fmt.Printf("  中群消息完成 (%v)\n", time.Since(t0).Round(time.Millisecond))

	// Step 5: User1 分别与 User2-User1000 各发 10 条单聊消息，双方交替发送
	dmPeerCount := userCount - 1
	fmt.Printf("\n=== Step 5: User1 ↔ User2-User10000 各 %d 条消息（共 %d 组） ===\n", dmMsgN, dmPeerCount)
	t0 = time.Now()
	for peerIdx := 1; peerIdx < userCount; peerIdx++ {
		peerUID := uids[peerIdx]
		for i := 0; i < dmMsgN; i++ {
			var senderUID, receiverUID int64
			var senderName string
			if i%2 == 0 {
				senderUID = uid1
				receiverUID = peerUID
				senderName = usernames[0]
			} else {
				senderUID = peerUID
				receiverUID = uid1
				senderName = usernames[peerIdx]
			}
			content := fmt.Sprintf("%s_%d", senderName, i+1)
			req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: pbUserTarget(receiverUID), MsgType: pb.MessageType(dal.MsgText), Body: pbTextBody(content)}
			resp := state.SendMessage(baseInfo(senderUID), req)
			if !ok(resp.GetBase()) {
				log.Fatalf("DM User1↔%s msg %d 失败: %s", usernames[peerIdx], i+1, resp.GetBase().GetMsg())
			}
		}
		if peerIdx%100 == 0 {
			fmt.Printf("  %d/%d 组完成 (%v)\n", peerIdx, dmPeerCount, time.Since(t0).Round(time.Millisecond))
		}
	}
	fmt.Printf("  DM 消息完成，共 %d 组 × %d 条 (%v)\n", dmPeerCount, dmMsgN, time.Since(t0).Round(time.Millisecond))

	// Step 6: 通讯录样例：User1 收藏群 + 组织架构
	fmt.Println("\n=== Step 6: 收藏群 + 组织架构 ===")
	t0 = time.Now()
	for _, gid := range []int64{bigGroupID, smallGroupID} {
		fresp := state.FavoriteGroup(baseInfo(uid1), &pb.FavoriteGroupRequest{GroupId: gid})
		if !ok(fresp.GetBase()) {
			log.Fatalf("收藏群 %d 失败: %s", gid, fresp.GetBase().GetMsg())
		}
	}
	fmt.Println("  User1 已收藏大群、中群")

	orgID := seedOrg(state, uids)
	fmt.Printf("  组织已创建 org_id=%d (%v)\n", orgID, time.Since(t0).Round(time.Millisecond))

	// Step 7: 直接读数据库验证数据完整性
	fmt.Println("\n=== Step 7: 验证（直接读数据库） ===")
	verify(db, uids, usernames, bigGroupID, smallGroupID, orgID)
}

// 组织架构样例的成员分布。
const (
	orgBackendN  = 10 // 后台组 uids[4..13]
	orgFrontendN = 10 // 前端组 uids[14..23]
	orgAdminN    = 10 // 行政部 uids[24..33]
)

// seedOrg 构建组织架构样例（tag 图 + 绝对排序 + 一人多岗）：
//
//	腾讯科技有限公司广州研发中心（根 tag）
//	├── 公司领导 (rank=10)：User1 总经理(rank=10)、User2 副总经理(rank=20)、User3 副总经理(未显式排序→名字沉底)
//	├── 研发部   (rank=20)：User3 研发部负责人(rank=1)
//	│   ├── 后台组 (rank=10)：User5 后台组长(rank=1)、User6-User14 按名字
//	│   └── 前端组 (rank=20)：User15-User24 按名字
//	└── 行政部   (rank=30)：User25-User34 按名字
func seedOrg(state *service.AppState, uids []int64) int64 {
	orgID, err := state.CreateOrg("腾讯科技有限公司广州研发中心", "")
	if err != nil {
		log.Fatalf("创建组织失败: %v", err)
	}
	mustTag := func(parent int64, name string, rank int64) int64 {
		tagID, err := state.AddOrgTag(orgID, parent, name, "", rank)
		if err != nil {
			log.Fatalf("创建 tag %s 失败: %v", name, err)
		}
		return tagID
	}
	mustMember := func(tagID, uid int64, title string, rank int64) {
		if err := state.AddOrgMember(orgID, tagID, uid, title, rank); err != nil {
			log.Fatalf("添加成员 uid=%d 到 tag=%d 失败: %v", uid, tagID, err)
		}
	}

	leadersTag := mustTag(orgID, "公司领导", 10)
	rndTag := mustTag(orgID, "研发部", 20)
	backendTag := mustTag(rndTag, "后台组", 10)
	frontendTag := mustTag(rndTag, "前端组", 20)
	adminTag := mustTag(orgID, "行政部", 30)

	// 公司领导：绝对排序（领导 1 排第一、领导 2 排第二），User3 未显式排序按名字沉底。
	mustMember(leadersTag, uids[0], "总经理", 10)
	mustMember(leadersTag, uids[1], "副总经理", 20)
	mustMember(leadersTag, uids[2], "副总经理", dal.OrgRankUnset)
	// 一人多岗：User3 在研发部 rank=1 排第一。
	mustMember(rndTag, uids[2], "研发部负责人", 1)
	// 后台组：User5 组长排第一，其余按名字。
	mustMember(backendTag, uids[4], "后台组长", 1)
	for i := 5; i < 4+orgBackendN; i++ {
		mustMember(backendTag, uids[i], "", dal.OrgRankUnset)
	}
	for i := 14; i < 14+orgFrontendN; i++ {
		mustMember(frontendTag, uids[i], "", dal.OrgRankUnset)
	}
	for i := 24; i < 24+orgAdminN; i++ {
		mustMember(adminTag, uids[i], "", dal.OrgRankUnset)
	}
	return orgID
}

func verify(db *shard.Database, uids []int64, usernames []string, bigGroupID, smallGroupID, orgID int64) {
	uid1 := uids[0]
	failures := 0

	check := func(name string, got, want int64) {
		if got != want {
			fmt.Printf("  FAIL %s: got %d, want %d\n", name, got, want)
			failures++
		}
	}

	// ---------- 1. 通讯录条目数（好友 + 收藏群 2 + 组织 1） ----------
	fmt.Println("  [1/8] 验证 User1 通讯录条目数...")
	contactStore := dal.NewContactStore(db.UIDShards.RouteInt64(uid1))
	contacts, _ := contactStore.List(uid1, 100000)
	check("User1 通讯录条目数", int64(len(contacts)), int64(userCount-1)+2+1)

	// ---------- 2. 群成员数 ----------
	fmt.Println("  [2/8] 验证群成员数...")
	bigStore := dal.NewGroupStore(db.GroupShards.RouteInt64(bigGroupID))
	bigMembers, _ := bigStore.ListAllMembers(bigGroupID)
	check("大群成员数", int64(len(bigMembers)), int64(userCount))

	smallStore := dal.NewGroupStore(db.GroupShards.RouteInt64(smallGroupID))
	smallMembers, _ := smallStore.ListAllMembers(smallGroupID)
	check("中群成员数", int64(len(smallMembers)), int64(smallGroupN))

	// ---------- 3. 每个用户的消息总数 ----------
	// User1:          大群系统(1) + 大群消息(100) + 中群系统(1) + 中群消息(10000) + 999组×2 DM
	// User2-User4:   大群系统(1) + 大群消息(100) + 中群系统(1) + 中群消息(10000) + 2 DM
	// User5-User1000: 大群系统(1) + 大群消息(100) + 2 DM
	fmt.Println("  [3/8] 验证每个用户的消息总数...")
	countMessages := func(uid int64) int64 {
		var count int64
		db.UIDShards.RouteInt64(uid).Reader.QueryRow(
			"SELECT COUNT(*) FROM messages WHERE uid = ?", uid,
		).Scan(&count)
		return count
	}
	for i, uid := range uids {
		var want int64
		switch {
		case i == 0: // User1
			want = 1 + int64(bigGroupMsgN) + 1 + int64(smallGroupMsgN) + int64(userCount-1)*int64(dmMsgN)
		case i < smallGroupN: // User2-User4（在中群中）
			want = 1 + int64(bigGroupMsgN) + 1 + int64(smallGroupMsgN) + int64(dmMsgN)
		default: // User5+（仅大群 + DM）
			want = 1 + int64(bigGroupMsgN) + int64(dmMsgN)
		}
		check(fmt.Sprintf("%s 消息数", usernames[i]), countMessages(uid), want)
	}

	// ---------- 4. 每个用户的会话数 ----------
	// User1:        大群(1) + 中群(1) + 999 DM = 1001
	// User2-User4:  大群(1) + 中群(1) + 1 DM(User1) = 3
	// User5-User1000: 大群(1) + 1 DM(User1) = 2
	fmt.Println("  [4/8] 验证每个用户的会话数...")
	countConversations := func(uid int64) int64 {
		var count int64
		db.UIDShards.RouteInt64(uid).Reader.QueryRow(
			"SELECT COUNT(*) FROM conversations WHERE uid = ?", uid,
		).Scan(&count)
		return count
	}
	for i, uid := range uids {
		var want int64
		switch {
		case i == 0:
			want = 2 + int64(userCount-1)
		case i < smallGroupN:
			want = 3
		default:
			want = 2
		}
		check(fmt.Sprintf("%s 会话数", usernames[i]), countConversations(uid), want)
	}

	// ---------- 5. 大群消息内容逐条验证（从 User1 收件箱） ----------
	fmt.Println("  [5/8] 验证大群消息内容...")
	rows, _ := db.UIDShards.RouteInt64(uid1).Reader.Query(
		"SELECT search_text FROM messages WHERE uid = ? AND group_id = ? AND msg_type = ? ORDER BY seq ASC",
		uid1, bigGroupID, dal.MsgText,
	)
	bigMsgIdx := 0
	if rows != nil {
		for rows.Next() {
			var content string
			rows.Scan(&content) //nolint:errcheck
			expected := fmt.Sprintf("大群_%s_%d", usernames[bigMsgIdx%userCount], bigMsgIdx+1)
			if content != expected {
				fmt.Printf("  FAIL 大群消息[%d]: got %q, want %q\n", bigMsgIdx, content, expected)
				failures++
			}
			bigMsgIdx++
		}
		rows.Close()
	}
	check("大群非系统消息条数", int64(bigMsgIdx), int64(bigGroupMsgN))

	// ---------- 6. DM 消息内容逐条验证（从 User1 收件箱） ----------
	fmt.Println("  [6/8] 验证 DM 消息内容...")
	for peerIdx := 1; peerIdx < userCount; peerIdx++ {
		peerUID := uids[peerIdx]
		rows, _ := db.UIDShards.RouteInt64(uid1).Reader.Query(
			"SELECT search_text FROM messages WHERE uid = ? AND group_id = 0 AND (from_uid = ? OR to_uid = ?) AND msg_type = ? ORDER BY seq ASC",
			uid1, peerUID, peerUID, dal.MsgText,
		)
		dmIdx := 0
		if rows != nil {
			for rows.Next() {
				var content string
				rows.Scan(&content) //nolint:errcheck
				senderName := usernames[0]
				if dmIdx%2 != 0 {
					senderName = usernames[peerIdx]
				}
				expected := fmt.Sprintf("%s_%d", senderName, dmIdx+1)
				if content != expected {
					fmt.Printf("  FAIL DM User1↔%s[%d]: got %q, want %q\n", usernames[peerIdx], dmIdx, content, expected)
					failures++
				}
				dmIdx++
			}
			rows.Close()
		}
		if int64(dmIdx) != int64(dmMsgN) {
			fmt.Printf("  FAIL DM User1↔%s 条数: got %d, want %d\n", usernames[peerIdx], dmIdx, dmMsgN)
			failures++
		}
	}

	// ---------- 7. 组织架构 ----------
	fmt.Println("  [7/8] 验证组织架构...")
	orgStore := dal.NewOrgStore(db.OrgShards.RouteInt64(orgID))
	memberUIDs, _ := orgStore.ActiveMemberUIDs(orgID)
	check("组织在职成员数", int64(len(memberUIDs)), 3+orgBackendN+orgFrontendN+orgAdminN) // User3 多岗去重

	rootItems, _ := orgStore.ListItemsPage(orgID, orgID, nil, false, 10)
	check("根 tag 直接子项数", int64(len(rootItems)), 3)
	if len(rootItems) == 3 {
		wantOrder := []string{"公司领导", "研发部", "行政部"}
		names, _ := orgStore.ListTagNames(orgID, []int64{rootItems[0].ChildTagID, rootItems[1].ChildTagID, rootItems[2].ChildTagID})
		for i, item := range rootItems {
			if names[item.ChildTagID][0] != wantOrder[i] {
				fmt.Printf("  FAIL 根展开顺序[%d]: got %q, want %q\n", i, names[item.ChildTagID][0], wantOrder[i])
				failures++
			}
		}
	}

	// ---------- 8. 组织成员的通讯录组织行 ----------
	fmt.Println("  [8/8] 验证组织成员的通讯录组织行...")
	for _, uid := range memberUIDs {
		row, _ := dal.NewContactStore(db.UIDShards.RouteInt64(uid)).GetByKey(uid, 0, 0, orgID)
		if row == nil || row.Status != dal.ContactFriend {
			fmt.Printf("  FAIL 成员 uid=%d 缺少通讯录组织行\n", uid)
			failures++
		}
	}

	// ---------- 汇总 ----------
	if failures == 0 {
		fmt.Println("\n  ALL PASSED")
	} else {
		fmt.Printf("\n  %d FAILURES\n", failures)
	}
	fmt.Println("\n=== 验证完成 ===")
}

// stopServer 通过 lsof 查找监听指定端口的进程并 kill。
func stopServer(port int) {
	out, err := exec.Command("lsof", "-ti", fmt.Sprintf(":%d", port)).Output()
	if err != nil || len(out) == 0 {
		fmt.Println("  未检测到运行中的服务器")
		return
	}
	pids := strings.Fields(strings.TrimSpace(string(out)))
	for _, pid := range pids {
		fmt.Printf("  关闭服务器进程 PID=%s\n", pid)
		exec.Command("kill", pid).Run()
	}
	// 等待端口释放
	time.Sleep(500 * time.Millisecond)
}

func pbUserTarget(uid int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: uid}}
}

func pbTextBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}}
}

func pbGroupTarget(groupID int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: groupID}}
}
