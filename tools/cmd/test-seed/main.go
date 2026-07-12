// test-seed 为 UI 测试构建轻量测试数据（使用 service 层接口）。
//
// 用法:
//
//	go run ./tools/cmd/test-seed [-config config.toml]
//
// 每次运行使用时间戳前缀创建全新用户，不删除旧数据。
// 前缀写入 {data_dir}/test-seed-prefix.txt 供 Playwright 测试读取。
//
// 构建内容（以前缀 p 为例）：
//   - 260 个用户 p_Test1..p_Test260，nickname 测试用户1..260，密码 test123
//   - p_Test1 与 p_Test2-p_Test260 互为好友
//   - 群 "p_测试群"（p_Test1-p_Test4），200 条消息
//   - 群 "p_大测试群"（p_Test1-p_Test250），用于群成员分页测试
//   - p_Test1 ↔ p_Test2 各 50 条 DM
//   - p_Test1 ↔ p_Test3 各 5 条 DM
//   - 组织 "p_测试组织"：公司领导（Test1 总经理 rank=10、Test2 副总沉底）+
//     测试部门（Test2 部门负责人 rank=1、Test3/Test4 按名字）+
//     远端部门（Test200-Test202，覆盖组织成员资料冷缓存刷新），用于组织 UI 测试
//
// 设计原则：
//   - 每次运行创建全新数据，旧数据累积用于考验系统稳定性
//   - 消息内容含序号，方便测试验证顺序
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/msgid"
	"yimsg/internal/plugin"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/service"
	"yimsg/internal/shard"
	"yimsg/internal/taskqueue"
	"yimsg/tools/internal/seedkit"
)

const (
	userCount       = 260
	password        = "test123"
	groupMsgN       = 200
	dmLongN         = 50
	dmShortN        = 5
	groupMembers    = 4   // Test1-Test4
	bigGroupMembers = 250 // Test1-Test250, 用于群成员分页测试
	dmFanout        = 120 // Test1 与 Test6.. 各建一条 DM 会话，用于会话列表有界消息流窗口测试
)

func main() {
	configPath := flag.String("config", "config.toml", "配置文件路径")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 生成时间戳前缀
	prefix := time.Now().Format("20060102_150405")

	t0 := time.Now()
	fmt.Printf("=== test-seed 前缀: %s ===\n", prefix)

	// Step 0: 确保数据目录存在（不删除旧数据）
	if err := os.MkdirAll(cfg.Database.DataDir, 0o755); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	if err := os.MkdirAll(cfg.Media.UploadDir, 0o755); err != nil {
		log.Fatalf("创建上传目录失败: %v", err)
	}

	db, err := shard.Open(cfg.Database.DataDir, cfg.Database.ShardCount, dal.Schemas())
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer db.Close()

	state := service.NewAppState(db, cfg, plugin.NewRegistry())
	// test-seed 不持久化任务，改用同步模式：每次发送返回前 fanout 已写入完成。
	tasks, err := taskqueue.Open("")
	if err != nil {
		log.Fatalf("打开任务队列失败: %v", err)
	}
	state.UseTaskQueue(tasks)
	tasks.SetSync()

	// Step 1: 注册用户（全部带时间戳前缀，每次都是新用户）
	fmt.Printf("注册 %d 个用户...\n", userCount)
	uids := make([]int64, userCount)
	usernames := make([]string, userCount)
	for i := 0; i < userCount; i++ {
		usernames[i] = fmt.Sprintf("%s_Test%d", prefix, i+1)
		nickname := fmt.Sprintf("测试用户%d", i+1)
		resp := state.Register(seedkit.BaseInfo(0), &pb.RegisterRequest{Username: usernames[i], Password: password, Nickname: nickname})
		if !seedkit.OK(resp.GetBase()) {
			log.Fatalf("注册 %s 失败: %s", usernames[i], resp.GetBase().GetMsg())
		}
		uids[i] = resp.GetUid()
	}
	uid1 := uids[0]
	fmt.Printf("  注册完成\n")

	// Step 2: Test1 与 Test2-Test260 互为好友
	fmt.Println("建立好友关系...")
	for i := 1; i < userCount; i++ {
		resp := state.AddFriend(seedkit.BaseInfo(uid1), &pb.AddFriendRequest{FriendUid: uids[i]})
		if !seedkit.OK(resp.GetBase()) {
			log.Fatalf("AddFriend: %s", resp.GetBase().GetMsg())
		}
		resp2 := state.AcceptFriend(seedkit.BaseInfo(uids[i]), &pb.AcceptFriendRequest{FriendUid: uid1})
		if !seedkit.OK(resp2.GetBase()) {
			log.Fatalf("AcceptFriend: %s", resp2.GetBase().GetMsg())
		}
	}

	// Step 2.5: Test1 主动给 Test6.. 各发一条 DM，建立大量会话（会话列表有界消息流窗口测试）。
	// 全部由 Test1 发出，因此 Test1 这些会话无未读；最先发送，因此排在会话列表最旧（底部），
	// 不影响群/长 DM 等既有种子会话在列表顶部的可见性，测试需向下滚动才能抵达这些会话。
	fmt.Printf("Test1 与 %d 个好友建立 DM 会话...\n", dmFanout)
	for i := 0; i < dmFanout; i++ {
		friendIdx := i + 5 // 避开 Test2/Test3（后续另建 DM）
		content := fmt.Sprintf("会话列表测试_%s_%d", usernames[friendIdx], i+1)
		req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: seedkit.UserTarget(uids[friendIdx]), MsgType: pb.MessageType(dal.MsgText), Body: seedkit.TextBody(content)}
		sresp := state.SendMessage(seedkit.BaseInfo(uid1), req)
		if !seedkit.OK(sresp.GetBase()) {
			log.Fatalf("会话列表 DM %d 失败: %s", i+1, sresp.GetBase().GetMsg())
		}
	}

	// Step 3: 创建群并发消息
	groupName := fmt.Sprintf("%s_测试群", prefix)
	fmt.Printf("创建群 %q（%d 人）+ %d 条消息...\n", groupName, groupMembers, groupMsgN)
	resp := state.CreateGroup(seedkit.BaseInfo(uid1), &pb.CreateGroupRequest{Name: groupName, MemberUids: uids[:groupMembers]})
	if !seedkit.OK(resp.GetBase()) {
		log.Fatalf("创建群失败: %s", resp.GetBase().GetMsg())
	}
	groupID := resp.GetGroupId()

	for i := 0; i < groupMsgN; i++ {
		senderIdx := i % groupMembers
		content := fmt.Sprintf("群消息_%s_%d", usernames[senderIdx], i+1)
		req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: seedkit.GroupTarget(groupID), MsgType: pb.MessageType(dal.MsgText), Body: seedkit.TextBody(content)}
		sresp := state.SendMessage(seedkit.BaseInfo(uids[senderIdx]), req)
		if !seedkit.OK(sresp.GetBase()) {
			log.Fatalf("群消息 %d 失败: %s", i+1, sresp.GetBase().GetMsg())
		}
	}

	// Step 3.5: 创建大群
	bigGroupName := fmt.Sprintf("%s_大测试群", prefix)
	fmt.Printf("创建群 %q（%d 人）...\n", bigGroupName, bigGroupMembers)
	bigResp := state.CreateGroup(seedkit.BaseInfo(uid1), &pb.CreateGroupRequest{Name: bigGroupName, MemberUids: uids[:bigGroupMembers]})
	if !seedkit.OK(bigResp.GetBase()) {
		log.Fatalf("创建大群失败: %s", bigResp.GetBase().GetMsg())
	}

	// Step 4: Test1 ↔ Test2 长 DM
	fmt.Printf("Test1 ↔ Test2: %d 条 DM...\n", dmLongN)
	sendDM(state, uids, usernames, 0, 1, dmLongN)

	// Step 5: Test1 ↔ Test3 短 DM
	fmt.Printf("Test1 ↔ Test3: %d 条 DM...\n", dmShortN)
	sendDM(state, uids, usernames, 0, 2, dmShortN)

	// Step 6: 组织架构样例（组织即根 tag；一人多岗：Test2 领导沉底、部门排第一）
	orgName := fmt.Sprintf("%s_测试组织", prefix)
	fmt.Printf("创建组织 %q...\n", orgName)
	// Test1（总经理）是组织根的初始管理员（GRANT 边），管理面权限自举唯一起点。
	orgID, err := state.CreateOrgDirect(orgName, "", uids[0])
	if err != nil {
		log.Fatalf("创建组织失败: %v", err)
	}
	leadersTag, err := state.AddOrgTag(orgID, orgID, "公司领导", "", 10)
	if err != nil {
		log.Fatalf("创建公司领导 tag 失败: %v", err)
	}
	deptTag, err := state.AddOrgTag(orgID, orgID, "测试部门", "", 20)
	if err != nil {
		log.Fatalf("创建测试部门 tag 失败: %v", err)
	}
	remoteTag, err := state.AddOrgTag(orgID, orgID, "远端部门", "", 30)
	if err != nil {
		log.Fatalf("创建远端部门 tag 失败: %v", err)
	}
	for _, m := range []struct {
		tag, uid int64
		title    string
		rank     int64
	}{
		{leadersTag, uids[0], "总经理", 10},
		{leadersTag, uids[1], "副总经理", dal.TagRankUnset},
		{deptTag, uids[1], "部门负责人", 1},
		{deptTag, uids[2], "", dal.TagRankUnset},
		{deptTag, uids[3], "", dal.TagRankUnset},
		{remoteTag, uids[199], "远端负责人", 1},
		{remoteTag, uids[200], "", dal.TagRankUnset},
		{remoteTag, uids[201], "", dal.TagRankUnset},
	} {
		if err := state.AddOrgMemberDirect(orgID, m.tag, m.uid, m.title, m.rank); err != nil {
			log.Fatalf("添加组织成员 uid=%d 失败: %v", m.uid, err)
		}
	}

	// 写入前缀文件供 Playwright 测试读取
	prefixFile := filepath.Join(cfg.Database.DataDir, "test-seed-prefix.txt")
	if err := os.WriteFile(prefixFile, []byte(prefix), 0o644); err != nil {
		log.Fatalf("写入前缀文件失败: %v", err)
	}

	fmt.Printf("\n完成！耗时 %v\n", time.Since(t0).Round(time.Millisecond))
	fmt.Printf("  前缀: %s\n", prefix)
	fmt.Printf("  用户: %d 个 (%s..%s, 密码: %s)\n", userCount, usernames[0], usernames[userCount-1], password)
	fmt.Printf("  好友: %s 有 %d 个好友\n", usernames[0], userCount-1)
	fmt.Printf("  群: %s (group_id=%d, %d 条消息)\n", groupName, groupID, groupMsgN)
	fmt.Printf("  大群: %s (%d 人)\n", bigGroupName, bigGroupMembers)
	fmt.Printf("  DM: Test1↔Test2 %d 条, Test1↔Test3 %d 条\n", dmLongN, dmShortN)
	fmt.Printf("  会话扇出: Test1 另与 %d 个好友各建 1 条 DM 会话\n", dmFanout)
	fmt.Printf("  组织: %s (org_id=%d, 公司领导 + 测试部门 + 远端部门)\n", orgName, orgID)
	fmt.Printf("  前缀文件: %s\n", prefixFile)
}

func sendDM(state *service.AppState, uids []int64, usernames []string, idx1, idx2, count int) {
	for i := 0; i < count; i++ {
		var senderIdx, receiverIdx int
		if i%2 == 0 {
			senderIdx, receiverIdx = idx1, idx2
		} else {
			senderIdx, receiverIdx = idx2, idx1
		}
		content := fmt.Sprintf("DM_%s→%s_%d", usernames[senderIdx], usernames[receiverIdx], i+1)
		req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: seedkit.UserTarget(uids[receiverIdx]), MsgType: pb.MessageType(dal.MsgText), Body: seedkit.TextBody(content)}
		resp := state.SendMessage(seedkit.BaseInfo(uids[senderIdx]), req)
		if !seedkit.OK(resp.GetBase()) {
			log.Fatalf("DM %d 失败: %s", i+1, resp.GetBase().GetMsg())
		}
	}
}
