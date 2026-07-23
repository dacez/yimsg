// seed-demo 清除所有数据并构建官网三种场景 demo 专用数据（使用 service 层接口）。
//
// 用法:
//
//	go run ./server/tools/cmd/seed-demo [-config config.toml]
//
// 与 seed-data（开发压测用，1000 随机账号）、test-seed（UI 自动化用，时间戳前缀增量数据）不同，
// seed-demo 只构造语义化、账号密码固定、可以直接写进官网页面文案里的三套演示数据集：
//
//   - 完整体验：demo_alice / demo_bob / demo_carol 互为好友，一个三人群「产品体验群」，
//     群里和两两单聊都预置几条消息。
//   - 客服：demo_kf_1 ~ demo_kf_6 六个客服人设账号；访客通过临时会话（无需好友关系，见
//     send_message 私聊校验放宽）直接联系，不需要任何预先加好友或白名单配置。demo_kf_1~3
//     由 yimsg-agent 依据各自私有知识库自动回复，用于智能客服组件 demo（见
//     packages/uikit/examples/customer-service.html）。每个客服账号还预置了一条来自专属
//     访客账号的留言，用于人工客服工作台 demo（一人同屏登录全部 6 个客服账号，模拟身兼
//     多个客服账号的值班场景）。
//   - 通讯录 + 组织架构：复用 demo_alice（已有 demo_bob / demo_carol 两个私人好友），额外
//     挂一个 4 层 tag、约 76 人的复杂组织架构，展示通讯录里"私人好友 + 组织"两种条目。
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/config"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/msgid"
	"yimsg/server/internal/plugin"
	"yimsg/server/internal/service"
	"yimsg/server/internal/shard"
	"yimsg/server/internal/taskqueue"
	"yimsg/server/tools/internal/seedkit"
)

// demoPassword 是所有 demo 账号统一密码，方便官网页面顶部直接展示。
const demoPassword = "Demo@123456"

// simpleTestPassword 是 z/d/c 三个简单测试账号的统一密码，仅供本地手动测试使用。
const simpleTestPassword = "zdc"

func main() {
	configPath := flag.String("config", "config.toml", "配置文件路径")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

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
	tasks, err := taskqueue.Open("")
	if err != nil {
		log.Fatalf("打开任务队列失败: %v", err)
	}
	state.UseTaskQueue(tasks)
	tasks.SetSync()

	fmt.Println("\n=== Step 1: 完整体验账号（demo_alice/demo_bob/demo_carol） ===")
	alice, bob, carol := seedFullChatDemo(state)

	fmt.Println("\n=== Step 2: 客服账号（demo_kf_1 ~ demo_kf_6） ===")
	kfUIDs, kfUsernames := seedCustomerServiceDemo(state)

	fmt.Println("\n=== Step 3: 通讯录 + 组织架构（挂在 demo_alice 名下） ===")
	orgID, orgMemberCount := seedOrgDemo(state, alice.uid)

	fmt.Println("\n=== Step 4: 简单测试账号（z/d/c，互为好友） ===")
	seedSimpleTestUsers(state)

	fmt.Println("\n=== 完成 ===")
	fmt.Printf("完整体验 demo：demo_alice / demo_bob / demo_carol，密码 %s\n", demoPassword)
	fmt.Printf("  群聊：产品体验群 group_id=%d；两两单聊已预置消息\n", alice.groupID)
	fmt.Printf("客服 demo：%s，密码 %s（访客侧走临时注册 + 临时会话，无需预先加好友）\n", strings.Join(kfUsernames, " / "), demoPassword)
	fmt.Printf("人工客服工作台 demo：以上 6 个客服账号已各预置一条待处理留言，密码同为 %s\n", demoPassword)
	fmt.Printf("通讯录 demo：demo_alice，密码 %s；组织 org_id=%d，共 %d 名在职成员\n", demoPassword, orgID, orgMemberCount)
	fmt.Printf("简单测试账号：z / d / c，密码 %s，三人互为好友\n", simpleTestPassword)
	_ = bob
	_ = carol
	_ = kfUIDs
}

type demoUser struct {
	uid     int64
	groupID int64
}

func register(state *service.AppState, username, nickname string) int64 {
	return registerWithPassword(state, username, nickname, demoPassword)
}

func registerWithPassword(state *service.AppState, username, nickname, password string) int64 {
	resp := state.Register(seedkit.BaseInfo(0), &pb.RegisterRequest{Username: username, Password: password, Nickname: nickname})
	if !seedkit.OK(resp.GetBase()) {
		log.Fatalf("注册 %s 失败: %s", username, resp.GetBase().GetMsg())
	}
	return resp.GetUid()
}

func makeFriends(state *service.AppState, uidA, uidB int64) {
	resp := state.AddFriend(seedkit.BaseInfo(uidA), &pb.AddFriendRequest{FriendUid: uidB})
	if !seedkit.OK(resp.GetBase()) {
		log.Fatalf("AddFriend %d→%d 失败: %s", uidA, uidB, resp.GetBase().GetMsg())
	}
	resp2 := state.AcceptFriend(seedkit.BaseInfo(uidB), &pb.AcceptFriendRequest{FriendUid: uidA})
	if !seedkit.OK(resp2.GetBase()) {
		log.Fatalf("AcceptFriend %d接受%d 失败: %s", uidB, uidA, resp2.GetBase().GetMsg())
	}
}

func sendText(state *service.AppState, fromUID int64, target *pb.ConversationTarget, content string) {
	req := &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: target, MsgType: pb.MessageType(dal.MsgText), Body: seedkit.TextBody(content)}
	resp := state.SendMessage(seedkit.BaseInfo(fromUID), req)
	if !seedkit.OK(resp.GetBase()) {
		log.Fatalf("发送消息失败: %s", resp.GetBase().GetMsg())
	}
}

// seedFullChatDemo 构造完整体验 demo：三人互为好友、一个三人群，群里和两两单聊都预置几条消息。
func seedFullChatDemo(state *service.AppState) (alice, bob, carol demoUser) {
	aliceUID := register(state, "demo_alice", "Alice")
	bobUID := register(state, "demo_bob", "Bob")
	carolUID := register(state, "demo_carol", "Carol")
	fmt.Println("  账号已注册：demo_alice / demo_bob / demo_carol")

	makeFriends(state, aliceUID, bobUID)
	makeFriends(state, aliceUID, carolUID)
	makeFriends(state, bobUID, carolUID)
	fmt.Println("  三人已互为好友")

	groupResp := state.CreateGroup(seedkit.BaseInfo(aliceUID), &pb.CreateGroupRequest{
		Name:       "产品体验群",
		MemberUids: []int64{aliceUID, bobUID, carolUID},
	})
	if !seedkit.OK(groupResp.GetBase()) {
		log.Fatalf("创建产品体验群失败: %s", groupResp.GetBase().GetMsg())
	}
	groupID := groupResp.GetGroupId()
	fmt.Printf("  产品体验群已创建 group_id=%d\n", groupID)

	groupMessages := []struct {
		fromUID int64
		content string
	}{
		{aliceUID, "欢迎体验 yimsg，这是一个三人群聊 demo～"},
		{bobUID, "消息实时同步，刷新页面也不会丢～"},
		{carolUID, "群聊、单聊都能在这个 demo 里体验到"},
	}
	for _, m := range groupMessages {
		sendText(state, m.fromUID, seedkit.GroupTarget(groupID), m.content)
	}

	sendText(state, aliceUID, seedkit.UserTarget(bobUID), "Bob，在的话给我发条消息试试～")
	sendText(state, bobUID, seedkit.UserTarget(aliceUID), "收到，单聊也没问题！")
	sendText(state, aliceUID, seedkit.UserTarget(carolUID), "Carol，这边也可以直接单聊我")
	sendText(state, carolUID, seedkit.UserTarget(aliceUID), "嗯嗯，消息秒到～")
	fmt.Println("  群聊、单聊消息已预置")

	return demoUser{uid: aliceUID, groupID: groupID}, demoUser{uid: bobUID}, demoUser{uid: carolUID}
}

// seedSimpleTestUsers 构造 z/d/c 三个简单测试账号，密码统一为 simpleTestPassword，三人互为好友，
// 供本地手动测试快速登录使用，不预置消息或群聊。
func seedSimpleTestUsers(state *service.AppState) {
	zUID := registerWithPassword(state, "z", "z", simpleTestPassword)
	dUID := registerWithPassword(state, "d", "d", simpleTestPassword)
	cUID := registerWithPassword(state, "c", "c", simpleTestPassword)
	fmt.Println("  账号已注册：z / d / c")

	makeFriends(state, zUID, dUID)
	makeFriends(state, zUID, cUID)
	makeFriends(state, dUID, cUID)
	fmt.Println("  三人已互为好友")
}

// seedCustomerServiceDemo 构造客服 demo 用到的六个客服人设账号；访客侧走真实临时注册 + 临时会话，
// 客服账号不需要任何预先加好友或白名单配置（私聊已不要求好友关系）。demo_kf_1~3 的昵称按
// yimsg-agent 私有知识库主题命名（见 agent/tools/cmd/seed-resources），与智能客服组件 demo
// 页面上的客服按钮标签保持一致。每个客服账号额外预置一个专属访客账号发来的一条留言，供人工
// 客服工作台 demo 使用：一人同屏登录全部 6 个客服账号时，每格都已经有一条待处理的真实客户消息。
func seedCustomerServiceDemo(state *service.AppState) (uids []int64, usernames []string) {
	agents := []struct {
		username   string
		nickname   string
		visitorMsg string
	}{
		{"demo_kf_1", "账号客服-小美", "您好，请问这个月账单为什么比上月多了20元？"},
		{"demo_kf_2", "接入客服-小林", "在的哈，我想咨询一下退货流程"},
		{"demo_kf_3", "值班客服-阿强", "订单一直显示配送中，能帮我查一下吗？"},
		{"demo_kf_4", "客服-晓雯", "优惠券领取不了，提示已过期"},
		{"demo_kf_5", "客服-老陈", "想问一下你们支持企业对公转账吗？"},
		{"demo_kf_6", "客服-思思", "刚才付款失败了，钱好像扣了"},
	}
	for _, a := range agents {
		uid := register(state, a.username, a.nickname)
		uids = append(uids, uid)
		usernames = append(usernames, a.username)

		visitorUsername := a.username + "_visitor"
		visitorUID := register(state, visitorUsername, "客户-"+a.nickname)
		sendText(state, visitorUID, seedkit.UserTarget(uid), a.visitorMsg)
	}
	fmt.Println("  客服账号已注册：" + strings.Join(usernames, " / "))
	fmt.Println("  每个客服账号已预置一条专属访客留言")
	return uids, usernames
}

// 组织架构规模：4 层 tag（根 -> 部门 -> 组 -> 子组）、约 76 名在职成员，
// 明显超过 seed-data 示例（4 个 tag、33 人），用于演示复杂组织架构。
const orgFillerCount = 75

// seedOrgDemo 构造挂在 uid 名下的复杂组织架构样例：
//
//	某某科技有限公司（根 tag）
//	├── 公司领导（rank10）：demo_alice 总经理、成员_1 副总经理
//	├── 产品部（rank20）
//	│   ├── 产品设计组（rank10）：15 人
//	│   └── 产品运营组（rank20）：10 人
//	├── 技术部（rank30）
//	│   ├── 后端组（rank10）
//	│   │   ├── 后端组-基础架构（rank10）：8 人
//	│   │   └── 后端组-业务中台（rank20）：8 人
//	│   ├── 前端组（rank20）：15 人
//	│   └── 测试组（rank30）：10 人
//	└── 市场部（rank40）：8 人
func seedOrgDemo(state *service.AppState, aliceUID int64) (orgID int64, memberCount int) {
	// demo_alice（总经理）是组织根的初始管理员（GRANT 边），管理面权限自举唯一起点。
	orgID, err := state.CreateOrgDirect("某某科技有限公司", "", aliceUID)
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
		if err := state.AddOrgMemberDirect(orgID, tagID, uid, title, rank); err != nil {
			log.Fatalf("添加成员 uid=%d 到 tag=%d 失败: %v", uid, tagID, err)
		}
	}

	leadersTag := mustTag(orgID, "公司领导", 10)
	productTag := mustTag(orgID, "产品部", 20)
	productDesignTag := mustTag(productTag, "产品设计组", 10)
	productOpsTag := mustTag(productTag, "产品运营组", 20)
	techTag := mustTag(orgID, "技术部", 30)
	backendTag := mustTag(techTag, "后端组", 10)
	backendInfraTag := mustTag(backendTag, "后端组-基础架构", 10)
	backendPlatformTag := mustTag(backendTag, "后端组-业务中台", 20)
	frontendTag := mustTag(techTag, "前端组", 20)
	qaTag := mustTag(techTag, "测试组", 30)
	marketingTag := mustTag(orgID, "市场部", 40)

	// 填充成员：demo_alice 之外的组织成员全部是仅用于展示组织架构规模的样例账号，
	// 不作为任何 demo 的登录入口。
	next := 0
	fillers := make([]int64, orgFillerCount)
	for i := 0; i < orgFillerCount; i++ {
		username := fmt.Sprintf("demo_org_member_%d", i+1)
		nickname := fmt.Sprintf("员工%d", i+1)
		fillers[i] = register(state, username, nickname)
	}
	nextFiller := func() int64 {
		uid := fillers[next]
		next++
		return uid
	}

	mustMember(leadersTag, aliceUID, "总经理", 10)
	mustMember(leadersTag, nextFiller(), "副总经理", dal.TagRankUnset)
	for i := 0; i < 15; i++ {
		mustMember(productDesignTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 10; i++ {
		mustMember(productOpsTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 8; i++ {
		mustMember(backendInfraTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 8; i++ {
		mustMember(backendPlatformTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 15; i++ {
		mustMember(frontendTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 10; i++ {
		mustMember(qaTag, nextFiller(), "", dal.TagRankUnset)
	}
	for i := 0; i < 8; i++ {
		mustMember(marketingTag, nextFiller(), "", dal.TagRankUnset)
	}
	fmt.Printf("  组织已创建 org_id=%d，共 %d 名在职成员（4 层 tag）\n", orgID, next+1)

	return orgID, next + 1 // +1 把 demo_alice 计入
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
	time.Sleep(500 * time.Millisecond)
}
