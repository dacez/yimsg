package e2e

import (
	"testing"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/config"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/plugin"
	"yimsg/server/internal/service"
	"yimsg/server/internal/shard"
	"yimsg/server/internal/taskqueue"
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
	orgChildPerson = pb.TagChildType_TAG_CHILD_TYPE_PERSON
	orgChildTag    = pb.TagChildType_TAG_CHILD_TYPE_TAG
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

// orgFixture 建一个最小组织并返回各 ID：
//
//	根（{run}_org）
//	├── 公司领导 (rank=10)：boss 总经理(rank=10)、a 副总(未显式排序 → 名字沉底)
//	└── xx部门   (rank=20)：a 部门负责人(rank=1)、staff 按名字
type orgFixture struct {
	orgID, leadersTag, deptTag int64
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
	return orgFixture{orgID: orgID, leadersTag: leadersTag, deptTag: deptTag}
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

	fx := buildOrgFixture(t, state, bossResp.GetUid(), aResp.GetUid(), staffResp.GetUid())

	// 非成员：展开与同步均 FORBIDDEN。
	resp := sendErr(outsider, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.orgID}, &pb.GetTagsResponse{})
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider expand error_code = %v, want FORBIDDEN", resp.GetBase().GetCode())
	}
	resp2 := sendErr(outsider, "sync_tags", &pb.SyncTagsRequest{OrgId: fx.orgID}, &pb.SyncTagsResponse{})
	if resp2.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider sync error_code = %v, want FORBIDDEN", resp2.GetBase().GetCode())
	}

	// 成员：sync_contacts 增量可见组织行（status=FRIEND）。
	sync := sendOK(staff, "sync_contacts", &pb.SyncContactsRequest{LastSeq: 0}, &pb.SyncContactsResponse{})
	foundOrg := false
	for _, c := range sync.GetContacts() {
		if c.GetTarget().GetOrgId() == fx.orgID && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			foundOrg = true
		}
	}
	if !foundOrg {
		t.Errorf("staff contacts missing org row: %+v", sync.GetContacts())
	}

	// get_org_infos 返回组织展示资料。
	infos := sendOK(staff, "get_org_infos", &pb.GetOrgInfosRequest{OrgIds: []int64{fx.orgID}}, &pb.GetOrgInfosResponse{})
	if len(infos.GetOrgs()) != 1 || infos.GetOrgs()[0].GetOrgId() != fx.orgID || infos.GetOrgs()[0].GetName() == "" {
		t.Errorf("get_org_infos wrong: %+v", infos.GetOrgs())
	}

	// staff 离职（唯一一条边被摘）→ 组织行 tombstone → 读组织被拒。
	if err := state.RemoveOrgMemberDirect(fx.orgID, fx.deptTag, staffResp.GetUid()); err != nil {
		t.Fatal(err)
	}
	sync = sendOK(staff, "sync_contacts", &pb.SyncContactsRequest{LastSeq: sync.GetCursorSeq()}, &pb.SyncContactsResponse{})
	foundTombstone := false
	for _, c := range sync.GetContacts() {
		if c.GetTarget().GetOrgId() == fx.orgID && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_DELETED {
			foundTombstone = true
		}
	}
	if !foundTombstone {
		t.Errorf("staff should sync org tombstone row: %+v", sync.GetContacts())
	}
	resp3 := sendErr(staff, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.orgID}, &pb.GetTagsResponse{})
	if resp3.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("ex-member expand error_code = %v, want FORBIDDEN", resp3.GetBase().GetCode())
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

	fx := buildOrgFixture(t, state, bossResp.GetUid(), aResp.GetUid(), staffResp.GetUid())

	// 根展开：公司领导(rank=10) 在 xx部门(rank=20) 前，均为 TAG 子项。
	root := sendOK(staff, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.orgID}, &pb.GetTagsResponse{})
	if len(root.GetTags()) != 2 {
		t.Fatalf("root relations = %d, want 2: %+v", len(root.GetTags()), root.GetTags())
	}
	if root.GetTags()[0].GetChildId() != fx.leadersTag || root.GetTags()[0].GetChildType() != orgChildTag {
		t.Errorf("root relation0 wrong: %+v", root.GetTags()[0])
	}
	if root.GetTags()[1].GetChildId() != fx.deptTag || root.GetTags()[1].GetChildType() != orgChildTag {
		t.Errorf("root relation1 wrong: %+v", root.GetTags()[1])
	}
	tagInfos := sendOK(staff, "get_tag_infos", &pb.GetTagInfosRequest{OrgId: fx.orgID, TagIds: []int64{fx.leadersTag, fx.deptTag}}, &pb.GetTagInfosResponse{})
	tagNames := map[int64]string{}
	for _, tg := range tagInfos.GetTags() {
		tagNames[tg.GetTagId()] = tg.GetName()
	}
	if tagNames[fx.leadersTag] != "公司领导" || tagNames[fx.deptTag] != "xx部门" {
		t.Errorf("get_tag_infos names wrong: %+v", tagNames)
	}

	// 公司领导：boss(rank=10) 第一；a 未显式排序按名字沉底最后（一人多岗处 1）。
	leaders := sendOK(staff, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.leadersTag}, &pb.GetTagsResponse{})
	if len(leaders.GetTags()) != 2 || leaders.GetTags()[0].GetChildId() != bossResp.GetUid() || leaders.GetTags()[1].GetChildId() != aResp.GetUid() {
		t.Fatalf("leaders order wrong: %+v", leaders.GetTags())
	}
	if leaders.GetTags()[0].GetChildType() != orgChildPerson {
		t.Errorf("boss relation should be PERSON: %+v", leaders.GetTags()[0])
	}
	if leaders.GetTags()[0].GetTitle() != "总经理" || leaders.GetTags()[0].GetRank() != 10 {
		t.Errorf("boss edge wrong: %+v", leaders.GetTags()[0])
	}

	// xx部门：a rank=1 排第一（一人多岗处 2，与公司领导中的排序互相独立）。
	dept := sendOK(staff, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.deptTag}, &pb.GetTagsResponse{})
	if len(dept.GetTags()) != 2 || dept.GetTags()[0].GetChildId() != aResp.GetUid() {
		t.Fatalf("dept order wrong: %+v", dept.GetTags())
	}
	if dept.GetTags()[0].GetTitle() != "部门负责人" || dept.GetTags()[0].GetRank() != 1 {
		t.Errorf("a dept edge wrong: %+v", dept.GetTags()[0])
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

	fx := buildOrgFixture(t, state, bossResp.GetUid(), aResp.GetUid(), staffResp.GetUid())

	// 全量分页拉到底：2 tag 边 + 4 人边 = 6 条关系，单游标顺扫。
	var lastSeq int64
	totalTags := 0
	for {
		resp := sendOK(staff, "sync_tags", &pb.SyncTagsRequest{OrgId: fx.orgID, LastSeq: lastSeq, Limit: 4}, &pb.SyncTagsResponse{})
		totalTags += len(resp.GetTags())
		if resp.GetCursorSeq() > 0 {
			lastSeq = resp.GetCursorSeq()
		}
		if !resp.GetHasMore() {
			break
		}
	}
	if totalTags != 6 {
		t.Fatalf("full sync relations=%d, want 6", totalTags)
	}

	// 增量：摘掉 a 的部门边（a 仍在公司领导，不离职）→ 一条边 tombstone。
	if err := state.RemoveOrgMemberDirect(fx.orgID, fx.deptTag, aResp.GetUid()); err != nil {
		t.Fatal(err)
	}
	inc := sendOK(staff, "sync_tags", &pb.SyncTagsRequest{OrgId: fx.orgID, LastSeq: lastSeq}, &pb.SyncTagsResponse{})
	if len(inc.GetTags()) != 1 {
		t.Fatalf("incremental relations=%d, want 1", len(inc.GetTags()))
	}
	if inc.GetTags()[0].GetStatus() != pb.TagStatus_TAG_STATUS_DELETED || inc.GetTags()[0].GetChildId() != aResp.GetUid() {
		t.Errorf("tombstone wrong: %+v", inc.GetTags()[0])
	}

	// GC 后旧游标 seq_too_old；rebuild=true 全量重建成功。
	if _, err := state.OrgStore(fx.orgID).Purge(fx.orgID); err != nil {
		t.Fatal(err)
	}
	old := sendErr(staff, "sync_tags", &pb.SyncTagsRequest{OrgId: fx.orgID, LastSeq: 1}, &pb.SyncTagsResponse{})
	if old.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Errorf("stale cursor error_code = %v, want SEQ_TOO_OLD", old.GetBase().GetCode())
	}
	rebuild := sendOK(staff, "sync_tags", &pb.SyncTagsRequest{OrgId: fx.orgID, LastSeq: 0, Rebuild: true}, &pb.SyncTagsResponse{})
	if len(rebuild.GetTags()) == 0 {
		t.Errorf("rebuild sync should return full relation set: %+v", rebuild)
	}
}

func int64Ptr(v int64) *int64 { return &v }

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

	fx := buildOrgFixture(t, state, bossResp.GetUid(), aResp.GetUid(), staffResp.GetUid())

	// 非管理员 staff 建部门被拒。
	forbiddenCreate := sendErr(staff, "create_org_tag", &pb.CreateOrgTagRequest{OrgId: fx.orgID, ParentTagId: fx.orgID, Name: "新部门"}, &pb.CreateOrgTagResponse{})
	if forbiddenCreate.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin create_org_tag error_code = %v, want FORBIDDEN", forbiddenCreate.GetBase().GetCode())
	}

	// boss（组织根 GRANT）建新部门、改新部门名、加成员、调排序。
	created := sendOK(boss, "create_org_tag", &pb.CreateOrgTagRequest{OrgId: fx.orgID, ParentTagId: fx.orgID, Name: "新部门"}, &pb.CreateOrgTagResponse{})
	if created.GetTagId() <= 0 {
		t.Fatalf("create_org_tag should return tag_id: %+v", created)
	}
	newTag := created.GetTagId()

	sendOK(boss, "rename_org_tag", &pb.RenameOrgTagRequest{OrgId: fx.orgID, TagId: newTag, Name: "新部门改名"}, &pb.RenameOrgTagResponse{})
	tagInfo := sendOK(boss, "get_tag_infos", &pb.GetTagInfosRequest{OrgId: fx.orgID, TagIds: []int64{newTag}}, &pb.GetTagInfosResponse{})
	if len(tagInfo.GetTags()) != 1 || tagInfo.GetTags()[0].GetName() != "新部门改名" {
		t.Errorf("rename_org_tag not applied: %+v", tagInfo.GetTags())
	}

	sendOK(boss, "add_org_member", &pb.AddOrgMemberRequest{OrgId: fx.orgID, TagId: newTag, Uid: staffResp.GetUid(), Title: "新部门负责人", Rank: int64Ptr(1)}, &pb.AddOrgMemberResponse{})
	newDept := sendOK(boss, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: newTag}, &pb.GetTagsResponse{})
	if len(newDept.GetTags()) != 1 || newDept.GetTags()[0].GetChildId() != staffResp.GetUid() {
		t.Fatalf("add_org_member not applied: %+v", newDept.GetTags())
	}

	sendOK(boss, "set_org_item_rank", &pb.SetOrgItemRankRequest{OrgId: fx.orgID, TagId: newTag, ChildId: staffResp.GetUid(), ChildType: orgChildPerson, Title: "改后的职务", Rank: 5}, &pb.SetOrgItemRankResponse{})
	newDept = sendOK(boss, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: newTag}, &pb.GetTagsResponse{})
	if newDept.GetTags()[0].GetTitle() != "改后的职务" || newDept.GetTags()[0].GetRank() != 5 {
		t.Errorf("set_org_item_rank not applied: %+v", newDept.GetTags()[0])
	}

	// boss 把 a 挂进新部门后再挂一个子 tag（link_org_tag 覆盖多父）。
	linked := sendOK(boss, "create_org_tag", &pb.CreateOrgTagRequest{OrgId: fx.orgID, ParentTagId: newTag, Name: "子组"}, &pb.CreateOrgTagResponse{})
	if linked.GetTagId() <= 0 {
		t.Fatalf("create_org_tag（子组）should return tag_id")
	}
	sendOK(boss, "link_org_tag", &pb.LinkOrgTagRequest{OrgId: fx.orgID, ParentTagId: fx.deptTag, ChildTagId: linked.GetTagId()}, &pb.LinkOrgTagResponse{})
	deptExpand := sendOK(boss, "get_tags", &pb.GetTagsRequest{OrgId: fx.orgID, TagId: fx.deptTag}, &pb.GetTagsResponse{})
	foundLinked := false
	for _, tg := range deptExpand.GetTags() {
		if tg.GetChildId() == linked.GetTagId() && tg.GetChildType() == orgChildTag {
			foundLinked = true
		}
	}
	if !foundLinked {
		t.Errorf("link_org_tag not applied: %+v", deptExpand.GetTags())
	}

	// boss 授权 staff 管理新部门（GRANT）；staff 现在能管新部门，管不到 xx部门（兄弟）。
	sendOK(boss, "grant_org_admin", &pb.GrantOrgAdminRequest{OrgId: fx.orgID, ScopeTagId: newTag, Uid: staffResp.GetUid()}, &pb.GrantOrgAdminResponse{})
	admins := sendOK(staff, "list_org_admins", &pb.ListOrgAdminsRequest{OrgId: fx.orgID, ScopeTagId: newTag}, &pb.ListOrgAdminsResponse{})
	foundStaffAdmin := false
	for _, u := range admins.GetAdminUids() {
		if u == staffResp.GetUid() {
			foundStaffAdmin = true
		}
	}
	if !foundStaffAdmin {
		t.Errorf("list_org_admins should include staff: %+v", admins.GetAdminUids())
	}
	sendOK(staff, "add_org_member", &pb.AddOrgMemberRequest{OrgId: fx.orgID, TagId: newTag, Uid: aResp.GetUid()}, &pb.AddOrgMemberResponse{})
	forbiddenSibling := sendErr(staff, "rename_org_tag", &pb.RenameOrgTagRequest{OrgId: fx.orgID, TagId: fx.deptTag, Name: "改名"}, &pb.RenameOrgTagResponse{})
	if forbiddenSibling.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("scoped admin managing sibling should be forbidden, got %v", forbiddenSibling.GetBase().GetCode())
	}

	// 撤权后 staff 立刻失去新部门管理权；remove_org_member / delete_org_tag / rename_org 仍需 boss。
	sendOK(boss, "revoke_org_admin", &pb.RevokeOrgAdminRequest{OrgId: fx.orgID, ScopeTagId: newTag, Uid: staffResp.GetUid()}, &pb.RevokeOrgAdminResponse{})
	forbiddenAfterRevoke := sendErr(staff, "add_org_member", &pb.AddOrgMemberRequest{OrgId: fx.orgID, TagId: newTag, Uid: aResp.GetUid()}, &pb.AddOrgMemberResponse{})
	if forbiddenAfterRevoke.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("revoked admin should be forbidden, got %v", forbiddenAfterRevoke.GetBase().GetCode())
	}
	sendOK(boss, "remove_org_member", &pb.RemoveOrgMemberRequest{OrgId: fx.orgID, TagId: newTag, Uid: aResp.GetUid()}, &pb.RemoveOrgMemberResponse{})
	sendOK(boss, "delete_org_tag", &pb.DeleteOrgTagRequest{OrgId: fx.orgID, TagId: newTag}, &pb.DeleteOrgTagResponse{})
	sendOK(boss, "rename_org", &pb.RenameOrgRequest{OrgId: fx.orgID, Name: "改名后的组织"}, &pb.RenameOrgResponse{})
	orgInfo := sendOK(boss, "get_org_infos", &pb.GetOrgInfosRequest{OrgIds: []int64{fx.orgID}}, &pb.GetOrgInfosResponse{})
	if len(orgInfo.GetOrgs()) != 1 || orgInfo.GetOrgs()[0].GetName() != "改名后的组织" {
		t.Errorf("rename_org not applied: %+v", orgInfo.GetOrgs())
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
	created := sendOK(alice, "create_org", &pb.CreateOrgRequest{Name: "阿尔法公司"}, &pb.CreateOrgResponse{})
	if created.GetOrgId() <= 0 {
		t.Fatalf("create_org should return org_id: %+v", created)
	}
	orgID := created.GetOrgId()

	// 创建者能直接建部门，无关用户不能。
	newTag := sendOK(alice, "create_org_tag", &pb.CreateOrgTagRequest{OrgId: orgID, ParentTagId: orgID, Name: "部门"}, &pb.CreateOrgTagResponse{})
	if newTag.GetTagId() <= 0 {
		t.Fatalf("creator should manage new org: %+v", newTag)
	}
	forbidden := sendErr(bob, "rename_org", &pb.RenameOrgRequest{OrgId: orgID, Name: "改名"}, &pb.RenameOrgResponse{})
	if forbidden.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin rename_org error_code = %v, want FORBIDDEN", forbidden.GetBase().GetCode())
	}

	// 唯一根管理员撤销自己应被拒绝（CONFLICT），组织至少保留一个根管理员。
	selfRevoke := sendErr(alice, "revoke_org_admin", &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: orgID, Uid: aliceResp.GetUid()}, &pb.RevokeOrgAdminResponse{})
	if selfRevoke.GetBase().GetCode() != pb.ErrorCode_ERROR_CONFLICT {
		t.Errorf("last root admin self-revoke error_code = %v, want CONFLICT", selfRevoke.GetBase().GetCode())
	}

	// 非根管理员不能删除组织；根管理员删除后组织展示资料立即消失。
	forbiddenDelete := sendErr(bob, "delete_org", &pb.DeleteOrgRequest{OrgId: orgID}, &pb.DeleteOrgResponse{})
	if forbiddenDelete.GetBase().GetCode() != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin delete_org error_code = %v, want FORBIDDEN", forbiddenDelete.GetBase().GetCode())
	}
	sendOK(alice, "delete_org", &pb.DeleteOrgRequest{OrgId: orgID}, &pb.DeleteOrgResponse{})
	afterDelete := sendOK(alice, "get_org_infos", &pb.GetOrgInfosRequest{OrgIds: []int64{orgID}}, &pb.GetOrgInfosResponse{})
	if len(afterDelete.GetOrgs()) != 0 {
		t.Errorf("org should be gone after delete_org: %+v", afterDelete.GetOrgs())
	}
	_ = bobResp
}
