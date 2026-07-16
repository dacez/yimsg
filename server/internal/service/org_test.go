package service

import (
	"testing"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/dal"
)

// buildTestOrg 建一个最小组织：根 + 公司领导 tag + xx 部门 tag，A 一人多岗。
// boss 是组织根的初始管理员（GRANT 边，CreateOrg 建组织时自举写入）。
//
//	根（腾讯科技有限公司广州研发中心，boss 持有 GRANT）
//	├── 公司领导：boss(rank=10)、A(未显式排序 → 名字沉底)
//	└── xx 部门：A(rank=1 排第一)、员工按名字
func buildTestOrg(t *testing.T, s *AppState, bossUID, aUID, staffUID int64) (orgID, leadersTag, deptTag int64) {
	t.Helper()
	orgID, err := s.CreateOrgDirect("腾讯科技有限公司广州研发中心", "", bossUID)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	leadersTag, err = s.AddOrgTag(orgID, orgID, "公司领导", "", 10)
	if err != nil {
		t.Fatalf("AddOrgTag leaders: %v", err)
	}
	deptTag, err = s.AddOrgTag(orgID, orgID, "xx部门", "", 20)
	if err != nil {
		t.Fatalf("AddOrgTag dept: %v", err)
	}
	if err := s.AddOrgMemberDirect(orgID, leadersTag, bossUID, "总经理", 10); err != nil {
		t.Fatalf("AddOrgMember boss: %v", err)
	}
	if err := s.AddOrgMemberDirect(orgID, leadersTag, aUID, "副总", dal.TagRankUnset); err != nil {
		t.Fatalf("AddOrgMember A leaders: %v", err)
	}
	if err := s.AddOrgMemberDirect(orgID, deptTag, aUID, "部门负责人", 1); err != nil {
		t.Fatalf("AddOrgMember A dept: %v", err)
	}
	if err := s.AddOrgMemberDirect(orgID, deptTag, staffUID, "", dal.TagRankUnset); err != nil {
		t.Fatalf("AddOrgMember staff: %v", err)
	}
	return orgID, leadersTag, deptTag
}

// TestOrgMembershipContactRow 验证入职写通讯录组织行、离职 tombstone，均可被 sync_contacts 增量看到。
func TestOrgMembershipContactRow(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "zz-A")
	staff := registerUser(t, s, "staff", "p", "bob")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	// 入职：A 的通讯录出现组织行（FRIEND），投影按组织名。
	row, err := s.ContactStore(a).GetByKey(a, 0, 0, orgID)
	if err != nil || row == nil {
		t.Fatalf("org contact row missing: %v %v", row, err)
	}
	if row.Status != dal.ContactFriend || row.OrgID != orgID {
		t.Errorf("org contact row wrong: %+v", row)
	}
	if row.SearchText != "腾讯科技有限公司广州研发中心" {
		t.Errorf("org contact search_text = %q", row.SearchText)
	}

	// sync_contacts 增量可见组织行。
	resp := syncContactsService(s, "r", a, 0, 100, false)
	if !isOK(resp) {
		t.Fatalf("sync_contacts: %s", errMsg(resp))
	}
	foundOrg := false
	for _, c := range resp.GetContacts() {
		if c.GetTarget().GetOrgId() == orgID {
			foundOrg = true
		}
	}
	if !foundOrg {
		t.Errorf("org row not in sync_contacts: %+v", resp.GetContacts())
	}

	// A 还挂在 xx 部门：摘掉公司领导边不离职；摘掉最后一条边才 tombstone。
	if err := s.RemoveOrgMemberDirect(orgID, leadersTag, a); err != nil {
		t.Fatal(err)
	}
	row, _ = s.ContactStore(a).GetByKey(a, 0, 0, orgID)
	if row == nil || row.Status != dal.ContactFriend {
		t.Fatalf("A should still be a member: %+v", row)
	}
	if err := s.RemoveOrgMemberDirect(orgID, deptTag, a); err != nil {
		t.Fatal(err)
	}
	row, _ = s.ContactStore(a).GetByKey(a, 0, 0, orgID)
	if row == nil || row.Status != dal.ContactDeleted {
		t.Fatalf("A org row should be tombstoned: %+v", row)
	}
}

// TestOrgPermission 验证非成员读组织被拒、成员可读。
func TestOrgPermission(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	outsider := registerUser(t, s, "out", "p", "Out")
	orgID, _, _ := buildTestOrg(t, s, boss, a, staff)

	resp := s.GetTags(testInfo(outsider), &pb.GetTagsRequest{OrgId: orgID, TagId: orgID})
	if resp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider expand should be forbidden, got %v", resp.Base.Code)
	}
	syncResp := s.SyncTags(testInfo(outsider), &pb.SyncTagsRequest{OrgId: orgID})
	if syncResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider sync should be forbidden, got %v", syncResp.Base.Code)
	}
	memberResp := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: orgID})
	if memberResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("member expand should succeed, got %v %s", memberResp.Base.Code, memberResp.Base.Msg)
	}
}

// TestOrgExpandOrderAndTagInfos 验证展开根/子 tag 的绝对排序、get_tag_infos 名字字典、
// 一人多岗两处可见且顺序不同。
func TestOrgExpandOrderAndTagInfos(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "zz-A") // 名字沉底
	staff := registerUser(t, s, "staff", "p", "bob")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	// 根展开：公司领导(rank=10) 在 xx部门(rank=20) 前，均为 TAG 子项。
	root := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: orgID})
	if root.Base.Code != pb.ErrorCode_ERROR_OK || len(root.Tags) != 2 {
		t.Fatalf("root expand: %v relations=%d", root.Base.Code, len(root.Tags))
	}
	if root.Tags[0].ChildId != leadersTag || root.Tags[0].ChildType != pb.TagChildType_TAG_CHILD_TYPE_TAG {
		t.Errorf("root relation0: %+v", root.Tags[0])
	}
	if root.Tags[1].ChildId != deptTag {
		t.Errorf("root relation1: %+v", root.Tags[1])
	}

	// get_tag_infos 批量取子 tag 名字字典。
	tagInfos := s.GetTagInfos(testInfo(staff), &pb.GetTagInfosRequest{OrgId: orgID, TagIds: []int64{leadersTag, deptTag}})
	if tagInfos.Base.Code != pb.ErrorCode_ERROR_OK || len(tagInfos.Tags) != 2 {
		t.Fatalf("get_tag_infos: %v tags=%d", tagInfos.Base.Code, len(tagInfos.Tags))
	}
	names := map[int64]string{}
	for _, tg := range tagInfos.Tags {
		names[tg.TagId] = tg.Name
	}
	if names[leadersTag] != "公司领导" || names[deptTag] != "xx部门" {
		t.Errorf("tag names wrong: %+v", names)
	}

	// 公司领导：boss(rank=10) 第一，A 未显式排序按名字沉底最后。
	leaders := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: leadersTag})
	if len(leaders.Tags) != 2 || leaders.Tags[0].ChildId != boss || leaders.Tags[1].ChildId != a {
		t.Fatalf("leaders order wrong: %+v", leaders.Tags)
	}
	if leaders.Tags[0].Title != "总经理" {
		t.Errorf("boss title = %q", leaders.Tags[0].Title)
	}

	// xx 部门：A rank=1 排第一。
	dept := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: deptTag})
	if len(dept.Tags) != 2 || dept.Tags[0].ChildId != a || dept.Tags[1].ChildId != staff {
		t.Fatalf("dept order wrong: %+v", dept.Tags)
	}

	// tag_id=0 非法；展开不存在的 tag 返回 NOT_FOUND。
	bad := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: 0})
	if bad.Base.Code != pb.ErrorCode_ERROR_INVALID_ARGUMENT {
		t.Errorf("tag_id=0 should be invalid, got %v", bad.Base.Code)
	}
	missing := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: 999999})
	if missing.Base.Code != pb.ErrorCode_ERROR_NOT_FOUND {
		t.Errorf("missing tag should be not found, got %v", missing.Base.Code)
	}
}

// TestOrgSyncAndSeqTooOld 验证增量同步游标推进、tombstone 下发与 seq_too_old 全量重建契约。
func TestOrgSyncAndSeqTooOld(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	// 全量分页拉到底。
	var lastSeq int64
	totalTags := 0
	for {
		resp := s.SyncTags(testInfo(staff), &pb.SyncTagsRequest{OrgId: orgID, LastSeq: lastSeq, Limit: 3})
		if resp.Base.Code != pb.ErrorCode_ERROR_OK {
			t.Fatalf("sync: %v %s", resp.Base.Code, resp.Base.Msg)
		}
		totalTags += len(resp.Tags)
		if resp.CursorSeq > 0 {
			lastSeq = resp.CursorSeq
		}
		if !resp.HasMore {
			break
		}
	}
	// 2 tag 边 + 4 人边 = 6 条关系。
	if totalTags != 6 {
		t.Fatalf("full sync relations=%d", totalTags)
	}

	// 增量：摘掉 A 的部门边 → 一条 tombstone。
	if err := s.RemoveOrgMemberDirect(orgID, deptTag, a); err != nil {
		t.Fatal(err)
	}
	resp := s.SyncTags(testInfo(staff), &pb.SyncTagsRequest{OrgId: orgID, LastSeq: lastSeq})
	if len(resp.Tags) != 1 {
		t.Fatalf("incremental: relations=%d", len(resp.Tags))
	}
	if resp.Tags[0].Status != pb.TagStatus_TAG_STATUS_DELETED || resp.Tags[0].ChildId != a || resp.Tags[0].TagId != deptTag {
		t.Errorf("tombstone wrong: %+v", resp.Tags[0])
	}
	lastSeq = resp.CursorSeq

	// GC 后旧游标触发 seq_too_old；rebuild=true 从 0 重来成功。
	if _, err := s.OrgStore(orgID).Purge(orgID); err != nil {
		t.Fatal(err)
	}
	old := s.SyncTags(testInfo(staff), &pb.SyncTagsRequest{OrgId: orgID, LastSeq: 1})
	if old.Base.Code != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Errorf("stale cursor should be seq_too_old, got %v", old.Base.Code)
	}
	rebuild := s.SyncTags(testInfo(staff), &pb.SyncTagsRequest{OrgId: orgID, LastSeq: 0, Rebuild: true})
	if rebuild.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("rebuild sync should succeed, got %v", rebuild.Base.Code)
	}
	_ = leadersTag
}

// TestOrgUpdatedFanout 验证结构变更后 org:updated 轻通知经 taskqueue 扇出给在线成员。
func TestOrgUpdatedFanout(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, _, deptTag := buildTestOrg(t, s, boss, a, staff)
	drainTasks(s) // 清空建制期间的扇出

	conn := s.Online().Register(staff, "")
	defer s.Online().Unregister(staff, conn)

	if err := s.SetOrgItemRankDirect(orgID, deptTag, staff, dal.TagChildPerson, "新职务", 5); err != nil {
		t.Fatal(err)
	}
	drainTasks(s)

	got := false
	for i := 0; i < 10 && !got; i++ {
		select {
		case msg := <-conn.Ch:
			if msg.Type == appmsg.NotificationNameOrgUpdated && msg.OrgID == orgID {
				got = true
			}
		default:
			i = 10
		}
	}
	if !got {
		t.Error("staff should receive org:updated with org_id")
	}
}

// TestOrgGetOrgInfosAndProjectionRefresh 验证批量展示资料 + 组织改名后投影惰性刷新。
func TestOrgGetOrgInfosAndProjectionRefresh(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, _, _ := buildTestOrg(t, s, boss, a, staff)

	resp := s.GetOrgInfos(testInfo(staff), &pb.GetOrgInfosRequest{OrgIds: []int64{orgID}})
	if resp.Base.Code != pb.ErrorCode_ERROR_OK || len(resp.Orgs) != 1 {
		t.Fatalf("get_org_infos: %v orgs=%d", resp.Base.Code, len(resp.Orgs))
	}
	if resp.Orgs[0].Name != "腾讯科技有限公司广州研发中心" {
		t.Errorf("org name = %q", resp.Orgs[0].Name)
	}

	// 组织改名 → 下次 get_org_infos 刷新调用方组织行投影。
	if err := s.RenameOrgDirect(orgID, "新研发中心", ""); err != nil {
		t.Fatal(err)
	}
	resp = s.GetOrgInfos(testInfo(staff), &pb.GetOrgInfosRequest{OrgIds: []int64{orgID}})
	if resp.Orgs[0].Name != "新研发中心" {
		t.Errorf("renamed org name = %q", resp.Orgs[0].Name)
	}
	row, _ := s.ContactStore(staff).GetByKey(staff, 0, 0, orgID)
	if row.SortKey != "新研发中心" || row.SearchText != "新研发中心" {
		t.Errorf("projection not refreshed: %+v", row)
	}
}

// TestOrgCycleAndRootGuards 验证防环与"根不为子"守卫。
func TestOrgCycleAndRootGuards(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	if err := s.LinkOrgTagDirect(orgID, deptTag, orgID, 1); err != errOrgRootAsChild {
		t.Errorf("linking root as child should fail, got %v", err)
	}
	// deptTag 下建一个孙 tag，再试图把 deptTag 挂到孙下 → 成环。
	teamTag, err := s.AddOrgTag(orgID, deptTag, "后台组", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkOrgTagDirect(orgID, teamTag, deptTag, 1); err != errOrgCycle {
		t.Errorf("cycle link should fail, got %v", err)
	}
	// 合法多父：leadersTag 下也挂后台组。
	if err := s.LinkOrgTagDirect(orgID, leadersTag, teamTag, 999); err != nil {
		t.Errorf("multi-parent link should succeed: %v", err)
	}
}

// TestOrgNicknameRefreshEdges 验证改昵称联动刷新组织边 sort_key 并扇出。
func TestOrgNicknameRefreshEdges(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "aaa")
	orgID, _, deptTag := buildTestOrg(t, s, boss, a, staff)

	// staff 改昵称 zzz → 部门内与 A(rank=1) 之后的名字序变化。
	resp := s.UpdateUserInfo(testInfo(staff), &pb.UpdateUserInfoRequest{Nickname: "zzz"})
	if resp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("update_user_info: %v", resp.Base.Code)
	}
	items := s.GetTags(testInfo(staff), &pb.GetTagsRequest{OrgId: orgID, TagId: deptTag})
	for _, item := range items.Tags {
		if item.ChildId == staff && item.SortKey != "zzz" {
			t.Errorf("edge sort_key not refreshed: %+v", item)
		}
	}
}

// TestOrgManageWriteActionsRequireGrant 验证管理面写 action 统一要求调用方对目标
// 节点（或祖先）持有 GRANT：非管理员被拒，root GRANT 全组织通杀。
func TestOrgManageWriteActionsRequireGrant(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, _, deptTag := buildTestOrg(t, s, boss, a, staff)

	// 普通成员 staff 没有任何 GRANT：建部门、加成员、改组织名均被拒。
	createResp := s.CreateOrgTag(testInfo(staff), &pb.CreateOrgTagRequest{OrgId: orgID, ParentTagId: orgID, Name: "新部门"})
	if createResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin create_org_tag should be forbidden, got %v", createResp.Base.Code)
	}
	addResp := s.AddOrgMember(testInfo(staff), &pb.AddOrgMemberRequest{OrgId: orgID, TagId: deptTag, Uid: a})
	if addResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin add_org_member should be forbidden, got %v", addResp.Base.Code)
	}
	renameResp := s.RenameOrg(testInfo(staff), &pb.RenameOrgRequest{OrgId: orgID, Name: "改名"})
	if renameResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin rename_org should be forbidden, got %v", renameResp.Base.Code)
	}

	// boss 持有组织根 GRANT：能建部门、能加成员、能改组织名。
	createResp = s.CreateOrgTag(testInfo(boss), &pb.CreateOrgTagRequest{OrgId: orgID, ParentTagId: orgID, Name: "新部门"})
	if createResp.Base.Code != pb.ErrorCode_ERROR_OK || createResp.TagId == 0 {
		t.Fatalf("root admin create_org_tag: %v tag_id=%d", createResp.Base.Code, createResp.TagId)
	}
	addResp = s.AddOrgMember(testInfo(boss), &pb.AddOrgMemberRequest{OrgId: orgID, TagId: createResp.TagId, Uid: staff, Title: "新成员"})
	if addResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("root admin add_org_member: %v", addResp.Base.Code)
	}
	renameResp = s.RenameOrg(testInfo(boss), &pb.RenameOrgRequest{OrgId: orgID, Name: "改名后的组织"})
	if renameResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("root admin rename_org: %v", renameResp.Base.Code)
	}
	infos := s.GetOrgInfos(testInfo(boss), &pb.GetOrgInfosRequest{OrgIds: []int64{orgID}})
	if len(infos.Orgs) != 1 || infos.Orgs[0].Name != "改名后的组织" {
		t.Errorf("org name not renamed: %+v", infos.Orgs)
	}
}

// TestOrgGrantRevokeListAdminsProtocol 验证 grant/revoke/list_org_admins 三个协议 action：
// 部门级 GRANT 只能管自己子树、管不到兄弟部门；撤权后立刻失去权限；管理员名单只对有权限者可见。
func TestOrgGrantRevokeListAdminsProtocol(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	// boss 把 staff 授权为 deptTag 的管理员。
	grantResp := s.GrantOrgAdmin(testInfo(boss), &pb.GrantOrgAdminRequest{OrgId: orgID, ScopeTagId: deptTag, Uid: staff})
	if grantResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("grant_org_admin: %v", grantResp.Base.Code)
	}

	// staff 现在能管 deptTag（加成员），但管不了 leadersTag（兄弟部门）或组织根。
	addResp := s.AddOrgMember(testInfo(staff), &pb.AddOrgMemberRequest{OrgId: orgID, TagId: deptTag, Uid: a, Title: "新职务"})
	if addResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("dept admin should manage own dept, got %v", addResp.Base.Code)
	}
	renameLeadersResp := s.RenameOrgTag(testInfo(staff), &pb.RenameOrgTagRequest{OrgId: orgID, TagId: leadersTag, Name: "改名"})
	if renameLeadersResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("dept admin should not manage sibling tag, got %v", renameLeadersResp.Base.Code)
	}
	renameOrgResp := s.RenameOrg(testInfo(staff), &pb.RenameOrgRequest{OrgId: orgID, Name: "改名"})
	if renameOrgResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("dept admin should not manage org root, got %v", renameOrgResp.Base.Code)
	}

	// 普通成员看不到 deptTag 的管理员名单；boss、staff（有管理权）可以看到。
	listByOutsider := s.ListOrgAdmins(testInfo(a), &pb.ListOrgAdminsRequest{OrgId: orgID, ScopeTagId: deptTag})
	if listByOutsider.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin list_org_admins should be forbidden, got %v", listByOutsider.Base.Code)
	}
	listByStaff := s.ListOrgAdmins(testInfo(staff), &pb.ListOrgAdminsRequest{OrgId: orgID, ScopeTagId: deptTag})
	if listByStaff.Base.Code != pb.ErrorCode_ERROR_OK || len(listByStaff.AdminUids) != 1 || listByStaff.AdminUids[0] != staff {
		t.Errorf("list_org_admins wrong: %v uids=%v", listByStaff.Base.Code, listByStaff.AdminUids)
	}

	// 撤权后 staff 立刻失去 deptTag 管理权。
	revokeResp := s.RevokeOrgAdmin(testInfo(boss), &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: deptTag, Uid: staff})
	if revokeResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("revoke_org_admin: %v", revokeResp.Base.Code)
	}
	addAfterRevoke := s.AddOrgMember(testInfo(staff), &pb.AddOrgMemberRequest{OrgId: orgID, TagId: deptTag, Uid: a})
	if addAfterRevoke.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("revoked admin should lose access, got %v", addAfterRevoke.Base.Code)
	}
}

// TestOrgCreateProtocol 验证 create_org 对任意登录用户开放，调用方自动成为
// 组织根的初始管理员（能立刻管理，无需额外授权）。
func TestOrgCreateProtocol(t *testing.T) {
	s := testState(t)
	alice := registerUser(t, s, "alice", "p", "Alice")

	resp := s.CreateOrg(testInfo(alice), &pb.CreateOrgRequest{Name: "新公司"})
	if resp.Base.Code != pb.ErrorCode_ERROR_OK || resp.OrgId == 0 {
		t.Fatalf("create_org: %v org_id=%d", resp.Base.Code, resp.OrgId)
	}

	// 创建者自动成为根管理员：能直接建部门。
	createTag := s.CreateOrgTag(testInfo(alice), &pb.CreateOrgTagRequest{OrgId: resp.OrgId, ParentTagId: resp.OrgId, Name: "部门"})
	if createTag.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("creator should manage new org, got %v", createTag.Base.Code)
	}

	// 无关用户没有权限。
	bob := registerUser(t, s, "bob", "p", "Bob")
	forbidden := s.RenameOrg(testInfo(bob), &pb.RenameOrgRequest{OrgId: resp.OrgId, Name: "改名"})
	if forbidden.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("non-admin should be forbidden, got %v", forbidden.Base.Code)
	}
}

// TestOrgLastRootAdminGuard 验证"组织至少保留一个根管理员"：唯一根管理员撤销
// 自己（或被撤销）会被拒绝；有第二个根管理员时可以正常撤销其一。
func TestOrgLastRootAdminGuard(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, _, deptTag := buildTestOrg(t, s, boss, a, staff)

	// boss 是唯一根管理员：自己撤销自己应被拒绝（CONFLICT），不是内部错误。
	selfRevoke := s.RevokeOrgAdmin(testInfo(boss), &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: orgID, Uid: boss})
	if selfRevoke.Base.Code != pb.ErrorCode_ERROR_CONFLICT {
		t.Fatalf("last root admin self-revoke should conflict, got %v", selfRevoke.Base.Code)
	}
	// 仍然是根管理员：能继续管理。
	stillAdmin := s.RenameOrg(testInfo(boss), &pb.RenameOrgRequest{OrgId: orgID, Name: "仍然管理"})
	if stillAdmin.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("boss should still be root admin after rejected self-revoke, got %v", stillAdmin.Base.Code)
	}

	// 授权 staff 为第二个根管理员后，撤销 boss 应该成功。
	grantResp := s.GrantOrgAdmin(testInfo(boss), &pb.GrantOrgAdminRequest{OrgId: orgID, ScopeTagId: orgID, Uid: staff})
	if grantResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("grant second root admin: %v", grantResp.Base.Code)
	}
	revokeBoss := s.RevokeOrgAdmin(testInfo(staff), &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: orgID, Uid: boss})
	if revokeBoss.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("revoke boss with a second admin present should succeed, got %v", revokeBoss.Base.Code)
	}
	// 现在 staff 是唯一根管理员，撤销 staff 自己应再次被拒绝。
	selfRevoke2 := s.RevokeOrgAdmin(testInfo(staff), &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: orgID, Uid: staff})
	if selfRevoke2.Base.Code != pb.ErrorCode_ERROR_CONFLICT {
		t.Errorf("new last root admin self-revoke should conflict, got %v", selfRevoke2.Base.Code)
	}

	// 子树级 GRANT（非组织根）没有这个约束：唯一部门管理员可以正常撤销。
	deptGrant := s.GrantOrgAdmin(testInfo(staff), &pb.GrantOrgAdminRequest{OrgId: orgID, ScopeTagId: deptTag, Uid: a})
	if deptGrant.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("grant dept admin: %v", deptGrant.Base.Code)
	}
	deptRevoke := s.RevokeOrgAdmin(testInfo(staff), &pb.RevokeOrgAdminRequest{OrgId: orgID, ScopeTagId: deptTag, Uid: a})
	if deptRevoke.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("sole dept admin revoke should succeed (no last-root-admin constraint on subtree), got %v", deptRevoke.Base.Code)
	}
}

// TestOrgDeleteProtocol 验证 delete_org：非根管理员被拒；根管理员删除后结构
// 清空，成员通讯录组织行经异步任务清理（离职语义）。
func TestOrgDeleteProtocol(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "A")
	staff := registerUser(t, s, "staff", "p", "S")
	orgID, _, _ := buildTestOrg(t, s, boss, a, staff)
	drainTasks(s) // 清空建制期间的扇出

	forbidden := s.DeleteOrg(testInfo(staff), &pb.DeleteOrgRequest{OrgId: orgID})
	if forbidden.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Fatalf("non-admin delete_org should be forbidden, got %v", forbidden.Base.Code)
	}

	del := s.DeleteOrg(testInfo(boss), &pb.DeleteOrgRequest{OrgId: orgID})
	if del.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Fatalf("delete_org: %v", del.Base.Code)
	}

	// 结构清空：组织展示资料不再存在。
	infos := s.GetOrgInfos(testInfo(boss), &pb.GetOrgInfosRequest{OrgIds: []int64{orgID}})
	if len(infos.Orgs) != 0 {
		t.Errorf("org info should be gone after delete, got %+v", infos.Orgs)
	}

	// 异步任务清理成员通讯录组织行（离职语义）。
	drainTasks(s)
	row, _ := s.ContactStore(staff).GetByKey(staff, 0, 0, orgID)
	if row == nil || row.Status != dal.ContactDeleted {
		t.Errorf("member contact row should be tombstoned after org delete: %+v", row)
	}
}
