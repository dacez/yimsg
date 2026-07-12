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
	// bossUID 是组织根的初始管理员（GRANT 边），管理面权限自举唯一起点。
	orgID, err := state.CreateOrgDirect(uniqueName("腾讯科技广州研发中心"), "", bossUID)
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
		if err := state.AddOrgMemberDirect(orgID, step.tag, step.uid, step.title, step.rank); err != nil {
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
	if err := state.RemoveOrgMemberDirect(fx.orgID, fx.deptTag, mustParseUID(t, staffResp.UID)); err != nil {
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
	if err := state.RemoveOrgMemberDirect(fx.orgID, fx.deptTag, mustParseUID(t, aResp.UID)); err != nil {
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

// TestOrgE2EManageWriteActions 端到端验证组织管理面写 action：非管理员被拒；
// 组织根 GRANT（boss）能建部门 / 加成员 / 改名 / 授权；被授权的部门管理员（staff）
// 能管自己部门、管不到兄弟部门；撤权后立刻失去权限。覆盖 create_org_tag /
// rename_org_tag / delete_org_tag / link_org_tag / add_org_member /
// remove_org_member / set_org_item_rank / rename_org / grant_org_admin /
// revoke_org_admin / list_org_admins 十一个 action 的协议层可用性。
func TestOrgE2EManageWriteActions(t *testing.T) {
	state := orgAdminState(t)

	boss := dial(t)
	bossResp := boss.registerAndLogin(uniqueName("boss"), "pw123456", "老板")
	a := dial(t)
	aResp := a.registerAndLogin(uniqueName("usera"), "pw123456", "阿伟")
	staff := dial(t)
	staffResp := staff.registerAndLogin(uniqueName("staff"), "pw123456", "小明")

	fx := buildOrgFixture(t, state,
		mustParseUID(t, bossResp.UID), mustParseUID(t, aResp.UID), mustParseUID(t, staffResp.UID))

	// 非管理员 staff 建部门被拒。
	forbiddenCreate := staff.sendErr(wsRequest{"action": "create_org_tag", "org_id": fx.orgIDStr, "parent_tag_id": fx.orgIDStr, "name": "新部门"})
	if forbiddenCreate.ErrorCode != "FORBIDDEN" {
		t.Errorf("non-admin create_org_tag error_code = %s, want FORBIDDEN", forbiddenCreate.ErrorCode)
	}

	// boss（组织根 GRANT）建新部门、改新部门名、加成员、调排序。
	created := boss.sendOK(wsRequest{"action": "create_org_tag", "org_id": fx.orgIDStr, "parent_tag_id": fx.orgIDStr, "name": "新部门"})
	if created.TagID == "" {
		t.Fatalf("create_org_tag should return tag_id: %+v", created)
	}
	newTag := created.TagID

	boss.sendOK(wsRequest{"action": "rename_org_tag", "org_id": fx.orgIDStr, "tag_id": newTag, "name": "新部门改名"})
	tagInfo := boss.sendOK(wsRequest{"action": "get_tag_infos", "org_id": fx.orgIDStr, "tag_ids": []string{newTag}})
	if len(tagInfo.Tags) != 1 || tagInfo.Tags[0].Name != "新部门改名" {
		t.Errorf("rename_org_tag not applied: %+v", tagInfo.Tags)
	}

	boss.sendOK(wsRequest{"action": "add_org_member", "org_id": fx.orgIDStr, "tag_id": newTag, "uid": staffResp.UID, "title": "新部门负责人", "rank": 1})
	newDept := boss.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": newTag})
	if len(newDept.Tags) != 1 || newDept.Tags[0].ChildID != staffResp.UID {
		t.Fatalf("add_org_member not applied: %+v", newDept.Tags)
	}

	boss.sendOK(wsRequest{"action": "set_org_item_rank", "org_id": fx.orgIDStr, "tag_id": newTag, "child_id": staffResp.UID, "child_type": orgChildPerson, "title": "改后的职务", "rank": 5})
	newDept = boss.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": newTag})
	if newDept.Tags[0].Title != "改后的职务" || newDept.Tags[0].Rank != 5 {
		t.Errorf("set_org_item_rank not applied: %+v", newDept.Tags[0])
	}

	// boss 把 a 挂进新部门后再挂一个子 tag（link_org_tag 覆盖多父）。
	linked := boss.sendOK(wsRequest{"action": "create_org_tag", "org_id": fx.orgIDStr, "parent_tag_id": newTag, "name": "子组"})
	if linked.TagID == "" {
		t.Fatalf("create_org_tag（子组）should return tag_id")
	}
	linkResp := boss.sendOK(wsRequest{"action": "link_org_tag", "org_id": fx.orgIDStr, "parent_tag_id": fx.deptTag, "child_tag_id": linked.TagID})
	_ = linkResp
	deptExpand := boss.sendOK(wsRequest{"action": "get_tags", "org_id": fx.orgIDStr, "tag_id": fx.deptTag})
	foundLinked := false
	for _, tg := range deptExpand.Tags {
		if tg.ChildID == linked.TagID && tg.ChildType == orgChildTag {
			foundLinked = true
		}
	}
	if !foundLinked {
		t.Errorf("link_org_tag not applied: %+v", deptExpand.Tags)
	}

	// boss 授权 staff 管理新部门（GRANT）；staff 现在能管新部门，管不到 xx部门（兄弟）。
	boss.sendOK(wsRequest{"action": "grant_org_admin", "org_id": fx.orgIDStr, "scope_tag_id": newTag, "uid": staffResp.UID})
	admins := staff.sendOK(wsRequest{"action": "list_org_admins", "org_id": fx.orgIDStr, "scope_tag_id": newTag})
	foundStaffAdmin := false
	for _, u := range admins.Uids {
		if u == staffResp.UID {
			foundStaffAdmin = true
		}
	}
	if !foundStaffAdmin {
		t.Errorf("list_org_admins should include staff: %+v", admins.Uids)
	}
	staff.sendOK(wsRequest{"action": "add_org_member", "org_id": fx.orgIDStr, "tag_id": newTag, "uid": aResp.UID})
	forbiddenSibling := staff.sendErr(wsRequest{"action": "rename_org_tag", "org_id": fx.orgIDStr, "tag_id": fx.deptTag, "name": "改名"})
	if forbiddenSibling.ErrorCode != "FORBIDDEN" {
		t.Errorf("scoped admin managing sibling should be forbidden, got %s", forbiddenSibling.ErrorCode)
	}

	// 撤权后 staff 立刻失去新部门管理权；remove_org_member / delete_org_tag / rename_org 仍需 boss。
	boss.sendOK(wsRequest{"action": "revoke_org_admin", "org_id": fx.orgIDStr, "scope_tag_id": newTag, "uid": staffResp.UID})
	forbiddenAfterRevoke := staff.sendErr(wsRequest{"action": "add_org_member", "org_id": fx.orgIDStr, "tag_id": newTag, "uid": aResp.UID})
	if forbiddenAfterRevoke.ErrorCode != "FORBIDDEN" {
		t.Errorf("revoked admin should be forbidden, got %s", forbiddenAfterRevoke.ErrorCode)
	}
	boss.sendOK(wsRequest{"action": "remove_org_member", "org_id": fx.orgIDStr, "tag_id": newTag, "uid": aResp.UID})
	boss.sendOK(wsRequest{"action": "delete_org_tag", "org_id": fx.orgIDStr, "tag_id": newTag})
	boss.sendOK(wsRequest{"action": "rename_org", "org_id": fx.orgIDStr, "name": "改名后的组织"})
	orgInfo := boss.sendOK(wsRequest{"action": "get_org_infos", "org_ids": []string{fx.orgIDStr}})
	if len(orgInfo.Orgs) != 1 || orgInfo.Orgs[0].Name != "改名后的组织" {
		t.Errorf("rename_org not applied: %+v", orgInfo.Orgs)
	}
}

// TestOrgE2ECreateDeleteAndLastRootAdminGuard 端到端验证 create_org 对任意登录
// 用户开放（调用方自动成为根管理员）、"组织至少一个根管理员"的撤权保护、以及
// delete_org 需要根管理权限且删除后结构立即不可读。
func TestOrgE2ECreateDeleteAndLastRootAdminGuard(t *testing.T) {
	alice := dial(t)
	aliceResp := alice.registerAndLogin(uniqueName("alice"), "pw123456", "创建者")
	bob := dial(t)
	bobResp := bob.registerAndLogin(uniqueName("bob"), "pw123456", "路人")

	// 任意登录用户可以 create_org，创建者自动成为根管理员。
	created := alice.sendOK(wsRequest{"action": "create_org", "name": "阿尔法公司"})
	if created.OrgID == "" {
		t.Fatalf("create_org should return org_id: %+v", created)
	}
	orgIDStr := created.OrgID

	// 创建者能直接建部门，无关用户不能。
	newTag := alice.sendOK(wsRequest{"action": "create_org_tag", "org_id": orgIDStr, "parent_tag_id": orgIDStr, "name": "部门"})
	if newTag.TagID == "" {
		t.Fatalf("creator should manage new org: %+v", newTag)
	}
	forbidden := bob.sendErr(wsRequest{"action": "rename_org", "org_id": orgIDStr, "name": "改名"})
	if forbidden.ErrorCode != "FORBIDDEN" {
		t.Errorf("non-admin rename_org error_code = %s, want FORBIDDEN", forbidden.ErrorCode)
	}

	// 唯一根管理员撤销自己应被拒绝（CONFLICT），组织至少保留一个根管理员。
	selfRevoke := alice.sendErr(wsRequest{"action": "revoke_org_admin", "org_id": orgIDStr, "scope_tag_id": orgIDStr, "uid": aliceResp.UID})
	if selfRevoke.ErrorCode != "CONFLICT" {
		t.Errorf("last root admin self-revoke error_code = %s, want CONFLICT", selfRevoke.ErrorCode)
	}

	// 非根管理员不能删除组织；根管理员删除后组织展示资料立即消失。
	forbiddenDelete := bob.sendErr(wsRequest{"action": "delete_org", "org_id": orgIDStr})
	if forbiddenDelete.ErrorCode != "FORBIDDEN" {
		t.Errorf("non-admin delete_org error_code = %s, want FORBIDDEN", forbiddenDelete.ErrorCode)
	}
	alice.sendOK(wsRequest{"action": "delete_org", "org_id": orgIDStr})
	afterDelete := alice.sendOK(wsRequest{"action": "get_org_infos", "org_ids": []string{orgIDStr}})
	if len(afterDelete.Orgs) != 0 {
		t.Errorf("org should be gone after delete_org: %+v", afterDelete.Orgs)
	}
	_ = bobResp
}
