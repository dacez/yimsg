package service

import (
	"testing"

	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
)

// buildTestOrg 建一个最小组织：根 + 公司领导 tag + xx 部门 tag，A 一人多岗。
//
//	根（腾讯科技有限公司广州研发中心）
//	├── 公司领导：boss(rank=10)、A(未显式排序 → 名字沉底)
//	└── xx 部门：A(rank=1 排第一)、员工按名字
func buildTestOrg(t *testing.T, s *AppState, bossUID, aUID, staffUID int64) (orgID, leadersTag, deptTag int64) {
	t.Helper()
	orgID, err := s.CreateOrg("腾讯科技有限公司广州研发中心", "")
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
	if err := s.AddOrgMember(orgID, leadersTag, bossUID, "总经理", 10); err != nil {
		t.Fatalf("AddOrgMember boss: %v", err)
	}
	if err := s.AddOrgMember(orgID, leadersTag, aUID, "副总", dal.OrgRankUnset); err != nil {
		t.Fatalf("AddOrgMember A leaders: %v", err)
	}
	if err := s.AddOrgMember(orgID, deptTag, aUID, "部门负责人", 1); err != nil {
		t.Fatalf("AddOrgMember A dept: %v", err)
	}
	if err := s.AddOrgMember(orgID, deptTag, staffUID, "", dal.OrgRankUnset); err != nil {
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
	if !resp.OK {
		t.Fatalf("sync_contacts: %s", resp.Error)
	}
	foundOrg := false
	for _, c := range resp.Contacts {
		if c.Target.OrgID != nil && int64(*c.Target.OrgID) == orgID {
			foundOrg = true
		}
	}
	if !foundOrg {
		t.Errorf("org row not in sync_contacts: %+v", resp.Contacts)
	}

	// A 还挂在 xx 部门：摘掉公司领导边不离职；摘掉最后一条边才 tombstone。
	if err := s.RemoveOrgMember(orgID, leadersTag, a); err != nil {
		t.Fatal(err)
	}
	row, _ = s.ContactStore(a).GetByKey(a, 0, 0, orgID)
	if row == nil || row.Status != dal.ContactFriend {
		t.Fatalf("A should still be a member: %+v", row)
	}
	if err := s.RemoveOrgMember(orgID, deptTag, a); err != nil {
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

	resp := s.GetOrgTagItems(testInfo(outsider), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: orgID})
	if resp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider expand should be forbidden, got %v", resp.Base.Code)
	}
	syncResp := s.SyncOrgTags(testInfo(outsider), &pb.SyncOrgTagsRequest{OrgId: orgID})
	if syncResp.Base.Code != pb.ErrorCode_ERROR_FORBIDDEN {
		t.Errorf("outsider sync should be forbidden, got %v", syncResp.Base.Code)
	}
	memberResp := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: orgID})
	if memberResp.Base.Code != pb.ErrorCode_ERROR_OK {
		t.Errorf("member expand should succeed, got %v %s", memberResp.Base.Code, memberResp.Base.Msg)
	}
}

// TestOrgExpandOrderAndNames 验证展开根/子 tag 的绝对排序与子 tag 名填充、一人多岗两处可见且顺序不同。
func TestOrgExpandOrderAndNames(t *testing.T) {
	s := testState(t)
	boss := registerUser(t, s, "boss", "p", "Boss")
	a := registerUser(t, s, "usera", "p", "zz-A") // 名字沉底
	staff := registerUser(t, s, "staff", "p", "bob")
	orgID, leadersTag, deptTag := buildTestOrg(t, s, boss, a, staff)

	// 根展开：公司领导(rank=10) 在 xx部门(rank=20) 前，且子 tag 名已填充。
	root := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: orgID})
	if root.Base.Code != pb.ErrorCode_ERROR_OK || len(root.Items) != 2 {
		t.Fatalf("root expand: %v items=%d", root.Base.Code, len(root.Items))
	}
	if root.Items[0].ChildTagId != leadersTag || root.Items[0].Name != "公司领导" {
		t.Errorf("root item0: %+v", root.Items[0])
	}
	if root.Items[1].ChildTagId != deptTag || root.Items[1].Name != "xx部门" {
		t.Errorf("root item1: %+v", root.Items[1])
	}

	// 公司领导：boss(rank=10) 第一，A 未显式排序按名字沉底最后。
	leaders := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: leadersTag})
	if len(leaders.Items) != 2 || leaders.Items[0].Uid != boss || leaders.Items[1].Uid != a {
		t.Fatalf("leaders order wrong: %+v", leaders.Items)
	}
	if leaders.Items[0].Title != "总经理" {
		t.Errorf("boss title = %q", leaders.Items[0].Title)
	}

	// xx 部门：A rank=1 排第一。
	dept := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: deptTag})
	if len(dept.Items) != 2 || dept.Items[0].Uid != a || dept.Items[1].Uid != staff {
		t.Fatalf("dept order wrong: %+v", dept.Items)
	}

	// tag_id=0 非法；展开不存在的 tag 返回 NOT_FOUND。
	bad := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: 0})
	if bad.Base.Code != pb.ErrorCode_ERROR_INVALID_ARGUMENT {
		t.Errorf("tag_id=0 should be invalid, got %v", bad.Base.Code)
	}
	missing := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: 999999})
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
	totalTags, totalItems := 0, 0
	for {
		resp := s.SyncOrgTags(testInfo(staff), &pb.SyncOrgTagsRequest{OrgId: orgID, LastSeq: lastSeq, Limit: 3})
		if resp.Base.Code != pb.ErrorCode_ERROR_OK {
			t.Fatalf("sync: %v %s", resp.Base.Code, resp.Base.Msg)
		}
		totalTags += len(resp.Tags)
		totalItems += len(resp.Items)
		if resp.CursorSeq > 0 {
			lastSeq = resp.CursorSeq
		}
		if !resp.HasMore {
			break
		}
	}
	// 3 节点（根、领导、部门）+ 6 边（2 tag 边 + 4 人边）。
	if totalTags != 3 || totalItems != 6 {
		t.Fatalf("full sync tags=%d items=%d", totalTags, totalItems)
	}

	// 增量：摘掉 A 的部门边 → 一条 tombstone。
	if err := s.RemoveOrgMember(orgID, deptTag, a); err != nil {
		t.Fatal(err)
	}
	resp := s.SyncOrgTags(testInfo(staff), &pb.SyncOrgTagsRequest{OrgId: orgID, LastSeq: lastSeq})
	if len(resp.Tags) != 0 || len(resp.Items) != 1 {
		t.Fatalf("incremental: tags=%d items=%d", len(resp.Tags), len(resp.Items))
	}
	if resp.Items[0].Status != pb.OrgTagStatus_ORG_TAG_STATUS_DELETED || resp.Items[0].Uid != a || resp.Items[0].TagId != deptTag {
		t.Errorf("tombstone wrong: %+v", resp.Items[0])
	}
	lastSeq = resp.CursorSeq

	// GC 后旧游标触发 seq_too_old；rebuild=true 从 0 重来成功。
	if _, err := s.OrgStore(orgID).Purge(orgID); err != nil {
		t.Fatal(err)
	}
	old := s.SyncOrgTags(testInfo(staff), &pb.SyncOrgTagsRequest{OrgId: orgID, LastSeq: 1})
	if old.Base.Code != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Errorf("stale cursor should be seq_too_old, got %v", old.Base.Code)
	}
	rebuild := s.SyncOrgTags(testInfo(staff), &pb.SyncOrgTagsRequest{OrgId: orgID, LastSeq: 0, Rebuild: true})
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

	if err := s.SetOrgItemRank(orgID, deptTag, 0, staff, "新职务", 5); err != nil {
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

	// 组织改名（根 tag 改名）→ 下次 get_org_infos 刷新调用方组织行投影。
	if err := s.RenameOrgTag(orgID, orgID, "新研发中心", ""); err != nil {
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

	if err := s.LinkOrgTag(orgID, deptTag, orgID, 1); err != errOrgRootAsChild {
		t.Errorf("linking root as child should fail, got %v", err)
	}
	// deptTag 下建一个孙 tag，再试图把 deptTag 挂到孙下 → 成环。
	teamTag, err := s.AddOrgTag(orgID, deptTag, "后台组", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkOrgTag(orgID, teamTag, deptTag, 1); err != errOrgCycle {
		t.Errorf("cycle link should fail, got %v", err)
	}
	// 合法多父：leadersTag 下也挂后台组。
	if err := s.LinkOrgTag(orgID, leadersTag, teamTag, 999); err != nil {
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
	items := s.GetOrgTagItems(testInfo(staff), &pb.GetOrgTagItemsRequest{OrgId: orgID, TagId: deptTag})
	for _, item := range items.Items {
		if item.Uid == staff && item.SortKey != "zzz" {
			t.Errorf("edge sort_key not refreshed: %+v", item)
		}
	}
}
