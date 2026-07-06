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
// get_org_infos / get_tag_infos / get_tags / sync_tags 读链路与权限。
// 未传 -config 时跳过本文件用例。
//
// 注意：org:updated / contacts:updated 扇出发生在写入进程内，e2e 进程建制时
// 通知不会到达连接服务端进程的 ws 客户端；通知扇出由 service 单测覆盖
// （TestOrgUpdatedFanout），e2e 只验证拉取语义。
const (
	orgChildPerson = 1 // TAG_CHILD_TYPE_PERSON
	orgChildTag    = 2 // TAG_CHILD_TYPE_TAG
)

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
		{leadersTag, aUID, "副总", dal.TagRankUnset},
		{deptTag, aUID, "部门负责人", 1},
		{deptTag, staffUID, "", dal.TagRankUnset},
	} {
		if err := state.AddOrgMember(orgID, step.tag, step.uid, step.title, step.rank, dal.TagRoleMember); err != nil {
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
	resp := outsider.sendErr(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if resp.ErrorCode != "FORBIDDEN" {
		t.Errorf("outsider expand error_code = %s, want FORBIDDEN", resp.ErrorCode)
	}
	resp = outsider.sendErr(wsRequest{"action": "sync_tags", "org_id": fx.orgIDStr})
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

	// get_org_infos 返回组织展示资料。
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
	resp = staff.sendErr(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if resp.ErrorCode != "FORBIDDEN" {
		t.Errorf("ex-member expand error_code = %s, want FORBIDDEN", resp.ErrorCode)
	}
	_ = a
}

// TestOrgE2EExpandOrderAndMultiPost 验证根/子 tag 展开的绝对排序与一人多岗；
// 子项展示名走独立的 get_tag_infos / get_user_infos 字典查询。
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

	// 根展开：公司领导(rank=10) 在 xx部门(rank=20) 前，均为 TAG 子项。
	root := staff.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fx.orgIDStr})
	if len(root.Tags) != 2 {
		t.Fatalf("root relations = %d, want 2: %+v", len(root.Tags), root.Tags)
	}
	wantLeadersTag := fmt.Sprint(fx.leadersTag)
	wantDeptTag := fmt.Sprint(fx.deptTag)
	if root.Tags[0].ChildID != wantLeadersTag || root.Tags[0].ChildType != orgChildTag {
		t.Errorf("root relation0 wrong: %+v", root.Tags[0])
	}
	if root.Tags[1].ChildID != wantDeptTag || root.Tags[1].ChildType != orgChildTag {
		t.Errorf("root relation1 wrong: %+v", root.Tags[1])
	}
	tagInfos := staff.sendOK(wsRequest{"action": "get_tag_infos", "org_id": fx.orgIDStr, "tag_ids": []string{wantLeadersTag, wantDeptTag}})
	tagNames := map[string]string{}
	for _, tg := range tagInfos.Tags {
		tagNames[tg.TagID] = tg.Name
	}
	if tagNames[wantLeadersTag] != "公司领导" || tagNames[wantDeptTag] != "xx部门" {
		t.Errorf("get_tag_infos names wrong: %+v", tagNames)
	}

	// 公司领导：boss(rank=10) 第一；a 未显式排序按名字沉底最后（一人多岗处 1）。
	leaders := staff.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fmt.Sprint(fx.leadersTag)})
	if len(leaders.Tags) != 2 || leaders.Tags[0].ChildID != bossResp.UID || leaders.Tags[1].ChildID != aResp.UID {
		t.Fatalf("leaders order wrong: %+v", leaders.Tags)
	}
	if leaders.Tags[0].ChildType != orgChildPerson {
		t.Errorf("boss relation should be PERSON: %+v", leaders.Tags[0])
	}
	if leaders.Tags[0].Title != "总经理" || leaders.Tags[0].Rank != 10 {
		t.Errorf("boss edge wrong: %+v", leaders.Tags[0])
	}

	// xx部门：a rank=1 排第一（一人多岗处 2，与公司领导中的排序互相独立）。
	dept := staff.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fmt.Sprint(fx.deptTag)})
	if len(dept.Tags) != 2 || dept.Tags[0].ChildID != aResp.UID {
		t.Fatalf("dept order wrong: %+v", dept.Tags)
	}
	if dept.Tags[0].Title != "部门负责人" || dept.Tags[0].Rank != 1 {
		t.Errorf("a dept edge wrong: %+v", dept.Tags[0])
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

	// 全量分页拉到底：2 tag 边 + 4 人边 = 6 条关系，单游标顺扫。
	var lastSeq int64
	totalTags := 0
	for {
		resp := staff.sendOK(wsRequest{"action": "sync_tags", "org_id": fx.orgIDStr, "last_seq": lastSeq, "limit": 4})
		totalTags += len(resp.Tags)
		if cursorSeqVal(resp.CursorSeq) > 0 {
			lastSeq = cursorSeqVal(resp.CursorSeq)
		}
		if !hasMoreVal(resp.HasMore) {
			break
		}
	}
	if totalTags != 6 {
		t.Fatalf("full sync relations=%d, want 6", totalTags)
	}

	// 增量：摘掉 a 的部门边（a 仍在公司领导，不离职）→ 一条边 tombstone。
	if err := state.RemoveOrgMember(fx.orgID, fx.deptTag, mustParseUID(t, aResp.UID)); err != nil {
		t.Fatal(err)
	}
	inc := staff.sendOK(wsRequest{"action": "sync_tags", "org_id": fx.orgIDStr, "last_seq": lastSeq})
	if len(inc.Tags) != 1 {
		t.Fatalf("incremental relations=%d, want 1", len(inc.Tags))
	}
	if inc.Tags[0].Status != int(dal.TagDeleted) || inc.Tags[0].ChildID != aResp.UID {
		t.Errorf("tombstone wrong: %+v", inc.Tags[0])
	}

	// GC 后旧游标 seq_too_old；rebuild=true 全量重建成功。
	if _, err := state.OrgStore(fx.orgID).Purge(fx.orgID); err != nil {
		t.Fatal(err)
	}
	old := staff.sendErr(wsRequest{"action": "sync_tags", "org_id": fx.orgIDStr, "last_seq": 1})
	if old.ErrorCode != "SEQ_TOO_OLD" {
		t.Errorf("stale cursor error_code = %s, want SEQ_TOO_OLD", old.ErrorCode)
	}
	rebuild := staff.sendOK(wsRequest{"action": "sync_tags", "org_id": fx.orgIDStr, "last_seq": 0, "rebuild": true})
	if len(rebuild.Tags) == 0 {
		t.Errorf("rebuild sync should return full relation set: %+v", rebuild)
	}
}
