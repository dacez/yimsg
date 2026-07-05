package e2e

import (
	"fmt"
	"strconv"
	"testing"

	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/plugin"
	"yimsg/internal/service"
	"yimsg/internal/shard"
	"yimsg/internal/taskqueue"
)

// 组织建制不上协议（管理工具直写），e2e 采用与 test-seed 相同的先例：
// 经 -config 打开服务端同一数据目录，用 service 层建制，再从 WebSocket 侧验证
// get_org_infos / get_org_tag_items / sync_org_tags 读链路与权限。
// 未传 -config 时跳过本文件用例。
//
// 注意：org:updated / contacts:updated 扇出发生在写入进程内，e2e 进程建制时
// 通知不会到达连接服务端进程的 ws 客户端；通知扇出由 service 单测覆盖
// （TestOrgUpdatedFanout），e2e 只验证拉取语义。
func orgAdminState(t *testing.T) *service.AppState {
	t.Helper()
	if configPath == "" {
		t.Skip("org e2e 需要 -config 指向服务端配置（run_all_tests.sh 已传入）")
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("加载配置失败: %v", err)
	}
	db, err := shard.Open(cfg.Database.DataDir, cfg.Database.ShardCount, dal.Schemas())
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	state := service.NewAppState(db, cfg, plugin.NewRegistry())
	tasks, err := taskqueue.Open("")
	if err != nil {
		t.Fatalf("打开任务队列失败: %v", err)
	}
	t.Cleanup(func() { tasks.Close() })
	state.UseTaskQueue(tasks)
	tasks.SetSync()
	return state
}

func mustParseUID(t *testing.T, s string) int64 {
	t.Helper()
	uid, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("parse uid %q: %v", s, err)
	}
	return uid
}

// orgFixture 建一个最小组织并返回各 ID：
//
//	根（{run}_org）
//	├── 公司领导 (rank=10)：boss 总经理(rank=10)、a 副总(未显式排序 → 名字沉底)
//	└── xx部门   (rank=20)：a 部门负责人(rank=1)、staff 按名字
type orgFixture struct {
	orgID, leadersTag, deptTag int64
	orgIDStr                   string
}

func buildOrgFixture(t *testing.T, state *service.AppState, bossUID, aUID, staffUID int64) orgFixture {
	t.Helper()
	orgID, err := state.CreateOrg(uniqueName("腾讯科技广州研发中心"), "")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	leadersTag, err := state.AddOrgTag(orgID, orgID, "公司领导", "", 10)
	if err != nil {
		t.Fatalf("AddOrgTag: %v", err)
	}
	deptTag, err := state.AddOrgTag(orgID, orgID, "xx部门", "", 20)
	if err != nil {
		t.Fatalf("AddOrgTag: %v", err)
	}
	for _, step := range []struct {
		tag, uid int64
		title    string
		rank     int64
	}{
		{leadersTag, bossUID, "总经理", 10},
		{leadersTag, aUID, "副总", dal.OrgRankUnset},
		{deptTag, aUID, "部门负责人", 1},
		{deptTag, staffUID, "", dal.OrgRankUnset},
	} {
		if err := state.AddOrgMember(orgID, step.tag, step.uid, step.title, step.rank); err != nil {
			t.Fatalf("AddOrgMember uid=%d: %v", step.uid, err)
		}
	}
	return orgFixture{orgID: orgID, leadersTag: leadersTag, deptTag: deptTag, orgIDStr: fmt.Sprintf("%d", orgID)}
}

// TestOrgE2EPermissionAndMembership 验证：非成员被拒；成员通讯录出现组织行；离职后行 tombstone 且不可再读。
func TestOrgE2EPermissionAndMembership(t *testing.T) {
	state := orgAdminState(t)

	boss := dial(t)
	bossResp := boss.registerAndLogin(uniqueName("boss"), "pw123456", "老板")
	a := dial(t)
	aResp := a.registerAndLogin(uniqueName("usera"), "pw123456", "zz-阿伟")
	staff := dial(t)
	staffResp := staff.registerAndLogin(uniqueName("staff"), "pw123456", "小明")
	outsider := dial(t)
	outsider.registerAndLogin(uniqueName("out"), "pw123456", "路人")

	fx := buildOrgFixture(t, state,
		mustParseUID(t, bossResp.UID), mustParseUID(t, aResp.UID), mustParseUID(t, staffResp.UID))

	// 非成员：展开与同步均 FORBIDDEN。
	resp := outsider.sendErr(wsRequest{"action": "get_org_tag_items", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if resp.ErrorCode != "FORBIDDEN" {
		t.Errorf("outsider expand error_code = %s, want FORBIDDEN", resp.ErrorCode)
	}
	resp = outsider.sendErr(wsRequest{"action": "sync_org_tags", "org_id": fx.orgIDStr})
	if resp.ErrorCode != "FORBIDDEN" {
		t.Errorf("outsider sync error_code = %s, want FORBIDDEN", resp.ErrorCode)
	}

	// 成员：sync_contacts 增量可见组织行（status=FRIEND）。
	sync := staff.sendOK(wsRequest{"action": "sync_contacts", "last_seq": 0})
	foundOrg := false
	for _, c := range sync.Contacts {
		if c.OrgID == fx.orgIDStr && c.Status == 1 {
			foundOrg = true
		}
	}
	if !foundOrg {
		t.Errorf("staff contacts missing org row: %+v", sync.Contacts)
	}

	// get_org_infos 返回根 tag 投影。
	infos := staff.sendOK(wsRequest{"action": "get_org_infos", "org_ids": []string{fx.orgIDStr}})
	if len(infos.Orgs) != 1 || infos.Orgs[0].OrgID != fx.orgIDStr || infos.Orgs[0].Name == "" {
		t.Errorf("get_org_infos wrong: %+v", infos.Orgs)
	}

	// staff 离职（唯一一条边被摘）→ 组织行 tombstone → 读组织被拒。
	if err := state.RemoveOrgMember(fx.orgID, fx.deptTag, mustParseUID(t, staffResp.UID)); err != nil {
		t.Fatal(err)
	}
	sync = staff.sendOK(wsRequest{"action": "sync_contacts", "last_seq": cursorSeqVal(sync.CursorSeq)})
	foundTombstone := false
	for _, c := range sync.Contacts {
		if c.OrgID == fx.orgIDStr && c.Status == statusDeleted {
			foundTombstone = true
		}
	}
	if !foundTombstone {
		t.Errorf("staff should sync org tombstone row: %+v", sync.Contacts)
	}
	resp = staff.sendErr(wsRequest{"action": "get_org_tag_items", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if resp.ErrorCode != "FORBIDDEN" {
		t.Errorf("ex-member expand error_code = %s, want FORBIDDEN", resp.ErrorCode)
	}
	_ = a
}

// TestOrgE2EExpandOrderAndMultiPost 验证根/子 tag 展开的绝对排序、子 tag 名填充与一人多岗。
func TestOrgE2EExpandOrderAndMultiPost(t *testing.T) {
	state := orgAdminState(t)

	boss := dial(t)
	bossResp := boss.registerAndLogin(uniqueName("boss"), "pw123456", "老板")
	a := dial(t)
	aResp := a.registerAndLogin(uniqueName("usera"), "pw123456", "zz-阿伟") // 名字沉底
	staff := dial(t)
	staffResp := staff.registerAndLogin(uniqueName("staff"), "pw123456", "小明")

	fx := buildOrgFixture(t, state,
		mustParseUID(t, bossResp.UID), mustParseUID(t, aResp.UID), mustParseUID(t, staffResp.UID))

	// 根展开：公司领导(rank=10) 在 xx部门(rank=20) 前，名字已填充。
	root := staff.sendOK(wsRequest{"action": "get_org_tag_items", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if len(root.Items) != 2 {
		t.Fatalf("root items = %d, want 2: %+v", len(root.Items), root.Items)
	}
	if root.Items[0].Name != "公司领导" || root.Items[1].Name != "xx部门" {
		t.Errorf("root order/names wrong: %+v", root.Items)
	}

	// 公司领导：boss(rank=10) 第一；a 未显式排序按名字沉底最后（一人多岗处 1）。
	leaders := staff.sendOK(wsRequest{"action": "get_org_tag_items", "org_id": fx.orgIDStr, "tag_id": fmt.Sprint(fx.leadersTag)})
	if len(leaders.Items) != 2 || leaders.Items[0].UID != bossResp.UID || leaders.Items[1].UID != aResp.UID {
		t.Fatalf("leaders order wrong: %+v", leaders.Items)
	}
	if leaders.Items[0].Title != "总经理" || leaders.Items[0].Rank != 10 {
		t.Errorf("boss edge wrong: %+v", leaders.Items[0])
	}

	// xx部门：a rank=1 排第一（一人多岗处 2，与公司领导中的排序互相独立）。
	dept := staff.sendOK(wsRequest{"action": "get_org_tag_items", "org_id": fx.orgIDStr, "tag_id": fmt.Sprint(fx.deptTag)})
	if len(dept.Items) != 2 || dept.Items[0].UID != aResp.UID {
		t.Fatalf("dept order wrong: %+v", dept.Items)
	}
	if dept.Items[0].Title != "部门负责人" || dept.Items[0].Rank != 1 {
		t.Errorf("a dept edge wrong: %+v", dept.Items[0])
	}
}

// TestOrgE2ESyncCursorAndRebuild 验证同步：全量分页、增量 tombstone、seq_too_old 全量重建。
func TestOrgE2ESyncCursorAndRebuild(t *testing.T) {
	state := orgAdminState(t)

	boss := dial(t)
	bossResp := boss.registerAndLogin(uniqueName("boss"), "pw123456", "老板")
	a := dial(t)
	aResp := a.registerAndLogin(uniqueName("usera"), "pw123456", "阿伟")
	staff := dial(t)
	staffResp := staff.registerAndLogin(uniqueName("staff"), "pw123456", "小明")

	fx := buildOrgFixture(t, state,
		mustParseUID(t, bossResp.UID), mustParseUID(t, aResp.UID), mustParseUID(t, staffResp.UID))

	// 全量分页拉到底：3 节点 + 6 边（2 tag 边 + 4 人边），单游标合并计数。
	var lastSeq int64
	totalTags, totalItems := 0, 0
	for {
		resp := staff.sendOK(wsRequest{"action": "sync_org_tags", "org_id": fx.orgIDStr, "last_seq": lastSeq, "limit": 4})
		totalTags += len(resp.Tags)
		totalItems += len(resp.Items)
		if cursorSeqVal(resp.CursorSeq) > 0 {
			lastSeq = cursorSeqVal(resp.CursorSeq)
		}
		if !hasMoreVal(resp.HasMore) {
			break
		}
	}
	if totalTags != 3 || totalItems != 6 {
		t.Fatalf("full sync tags=%d items=%d, want 3/6", totalTags, totalItems)
	}

	// 增量：摘掉 a 的部门边（a 仍在公司领导，不离职）→ 一条边 tombstone。
	if err := state.RemoveOrgMember(fx.orgID, fx.deptTag, mustParseUID(t, aResp.UID)); err != nil {
		t.Fatal(err)
	}
	inc := staff.sendOK(wsRequest{"action": "sync_org_tags", "org_id": fx.orgIDStr, "last_seq": lastSeq})
	if len(inc.Tags) != 0 || len(inc.Items) != 1 {
		t.Fatalf("incremental tags=%d items=%d, want 0/1", len(inc.Tags), len(inc.Items))
	}
	if inc.Items[0].Status != int(dal.OrgTagDeleted) || inc.Items[0].UID != aResp.UID {
		t.Errorf("tombstone wrong: %+v", inc.Items[0])
	}

	// GC 后旧游标 seq_too_old；rebuild=true 全量重建成功。
	if _, err := state.OrgStore(fx.orgID).Purge(fx.orgID); err != nil {
		t.Fatal(err)
	}
	old := staff.sendErr(wsRequest{"action": "sync_org_tags", "org_id": fx.orgIDStr, "last_seq": 1})
	if old.ErrorCode != "SEQ_TOO_OLD" {
		t.Errorf("stale cursor error_code = %s, want SEQ_TOO_OLD", old.ErrorCode)
	}
	rebuild := staff.sendOK(wsRequest{"action": "sync_org_tags", "org_id": fx.orgIDStr, "last_seq": 0, "rebuild": true})
	if len(rebuild.Tags) == 0 {
		t.Errorf("rebuild sync should return full graph: %+v", rebuild)
	}
}
