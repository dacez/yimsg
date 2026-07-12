package dal

import (
	"strconv"
	"testing"
)

// orgStore 返回单分片内存库上的 OrgStore（org 分片组）。
func orgStore(t *testing.T) *OrgStore {
	t.Helper()
	db := setupDB(t)
	return NewOrgStore(db.OrgShards.AllShards()[0])
}

// addMember 是测试辅助：按昵称算好 sort_key 后把人挂进 tag。
func addMember(t *testing.T, s *OrgStore, orgID, tagID, uid int64, nickname, title string, rank int64) (int64, bool) {
	t.Helper()
	seq, hadActive, err := s.UpsertTag(orgID, tagID, uid, TagChildPerson, title, rank, ContactSortKey("", nickname), 1000)
	if err != nil {
		t.Fatalf("UpsertTag uid=%d: %v", uid, err)
	}
	return seq, hadActive
}

// linkTag 是测试辅助：按 tag 名算好 sort_key 后把子 tag 挂进父节点（父节点可以是组织根）。
func linkTag(t *testing.T, s *OrgStore, orgID, parentTagID, childTagID int64, name string, rank int64) {
	t.Helper()
	if _, _, err := s.UpsertTag(orgID, parentTagID, childTagID, TagChildTag, "", rank, ContactSortKey("", name), 1000); err != nil {
		t.Fatalf("UpsertTag child=%d: %v", childTagID, err)
	}
}

// grantAdmin 是测试辅助：给 uid 挂一条 GRANT 边，授权其管理 scopeTagID 为根的子树。
func grantAdmin(t *testing.T, s *OrgStore, orgID, scopeTagID, uid int64) {
	t.Helper()
	if _, _, err := s.UpsertTag(orgID, scopeTagID, uid, TagChildGrant, "", TagRankUnset, "", 1000); err != nil {
		t.Fatalf("grant admin scope=%d uid=%d: %v", scopeTagID, uid, err)
	}
}

// TestOrgExpandAbsoluteOrder 验证展开排序：rank 优先、sort_key 次之、child_type/child_id 兜底，
// tag 与人混排，且仅返回 ACTIVE 行。
func TestOrgExpandAbsoluteOrder(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if err := s.UpsertOrgInfo(orgID, "广州研发中心", "", 1000); err != nil {
		t.Fatalf("UpsertOrgInfo: %v", err)
	}
	if err := s.UpsertTagInfo(orgID, 201, "秘书处", "", 1000); err != nil {
		t.Fatalf("UpsertTagInfo: %v", err)
	}

	// 领导 1/2 显式 rank；员工按名字排；子 tag 沉底（rank 编排到人之后）。
	addMember(t, s, orgID, orgID, 11, "Zed", "领导1", 10)
	addMember(t, s, orgID, orgID, 12, "Amy", "领导2", 20)
	addMember(t, s, orgID, orgID, 13, "Carol", "", TagRankUnset)
	addMember(t, s, orgID, orgID, 14, "bob", "", TagRankUnset)
	linkTag(t, s, orgID, orgID, 201, "秘书处", 900000)

	rows, err := s.ListTagsPage(orgID, orgID, nil, false, 10)
	if err != nil {
		t.Fatalf("ListTagsPage: %v", err)
	}
	type want struct {
		childID   int64
		childType uint8
	}
	wants := []want{
		{11, TagChildPerson}, {12, TagChildPerson}, {201, TagChildTag}, {14, TagChildPerson}, {13, TagChildPerson},
	} // 领导1、领导2、秘书处(rank=900000)、bob、carol
	if len(rows) != len(wants) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(wants), rows)
	}
	for i, w := range wants {
		if rows[i].ChildID != w.childID || rows[i].ChildType != w.childType {
			t.Errorf("row %d: child_id=%d child_type=%d want %+v (%+v)", i, rows[i].ChildID, rows[i].ChildType, w, rows[i])
		}
	}
}

// TestOrgExpandKeysetPaging 验证 keyset 翻页无重无漏。
func TestOrgExpandKeysetPaging(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	names := []string{"a", "b", "c", "d", "e"}
	for i, n := range names {
		addMember(t, s, orgID, orgID, int64(20+i), n, "", TagRankUnset)
	}

	first, err := s.ListTagsPage(orgID, orgID, nil, false, 2)
	if err != nil || len(first) != 2 {
		t.Fatalf("first page: %v %d", err, len(first))
	}
	// 游标即上一页末行的 keyset 字段 [rank, sort_key, child_type, child_id]。
	last := first[1]
	cursor := []string{
		strconv.FormatInt(last.Rank, 10), last.SortKey,
		strconv.FormatInt(int64(last.ChildType), 10), strconv.FormatInt(last.ChildID, 10),
	}
	second, err := s.ListTagsPage(orgID, orgID, cursor, false, 10)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second) != 3 {
		t.Fatalf("second page rows=%d want 3", len(second))
	}
	if second[0].SortKey != "c" || second[2].SortKey != "e" {
		t.Errorf("second page order wrong: %+v", second)
	}
}

// TestOrgMultiPostIndependentRank 验证一人多岗：同一 uid 在不同 tag 下 rank 互相独立。
func TestOrgMultiPostIndependentRank(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const leadersTag, deptTag = 301, 302
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTagInfo(orgID, leadersTag, "公司领导", "", 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTagInfo(orgID, deptTag, "xx部门", "", 1000); err != nil {
		t.Fatal(err)
	}

	// A（名字靠后）在公司领导未显式排序 → 按名字沉底；在 xx 部门 rank=1 排第一。
	_, had := addMember(t, s, orgID, leadersTag, 41, "zz-A", "", TagRankUnset)
	if had {
		t.Error("first edge should report hadActive=false")
	}
	addMember(t, s, orgID, leadersTag, 42, "aa-B", "", TagRankUnset)
	_, had = addMember(t, s, orgID, deptTag, 41, "zz-A", "部门负责人", 1)
	if !had {
		t.Error("second edge should report hadActive=true")
	}
	addMember(t, s, orgID, deptTag, 43, "aa-C", "", TagRankUnset)

	leaders, err := s.ListTagsPage(orgID, leadersTag, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if leaders[len(leaders)-1].ChildID != 41 {
		t.Errorf("A should be last in leaders tag: %+v", leaders)
	}
	dept, err := s.ListTagsPage(orgID, deptTag, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if dept[0].ChildID != 41 {
		t.Errorf("A should be first in dept tag: %+v", dept)
	}
}

// TestOrgSyncPageMergedCursor 验证关系表的单游标增量翻页、tombstone 可见。
// org_info / tag_info 是无 seq 的字典，不进入同步流；只有 org_relation 产生 seq。
func TestOrgSyncPageMergedCursor(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTagInfo(orgID, 401, "dept", "", 1000); err != nil {
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, 401, "dept", 100)           // seq 1
	addMember(t, s, orgID, 401, 51, "n1", "", TagRankUnset) // seq 2

	// 全量第一页 limit=1：应拿到 seq 1（链接边），has_more。
	rows, hasMore, err := s.SyncPage(orgID, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !hasMore {
		t.Fatalf("page1 rows=%d hasMore=%v", len(rows), hasMore)
	}
	// 第二页从 seq 1 之后：seq 2（人边），无更多。
	rows, hasMore, err = s.SyncPage(orgID, rows[0].Seq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || hasMore {
		t.Fatalf("page2 rows=%d hasMore=%v", len(rows), hasMore)
	}

	// 摘人 → tombstone 进入增量流。
	lastSeq := rows[0].Seq
	removed, still, err := s.RemoveTag(orgID, 401, 51, TagChildPerson, 2000)
	if err != nil || !removed || still {
		t.Fatalf("RemoveTag: %v removed=%v still=%v", err, removed, still)
	}
	rows, _, err = s.SyncPage(orgID, lastSeq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Status != TagDeleted {
		t.Fatalf("tombstone not synced: %+v", rows)
	}
}

// TestOrgDeleteTagCascade 验证删 tag 物理删字典行 + 级联墓碑两个方向的边，
// 且 DAG 中被挂在别处的子节点不受影响。
func TestOrgDeleteTagCascade(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const deptA, deptB, teamC = 501, 502, 503
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id   int64
		name string
	}{{deptA, "A"}, {deptB, "B"}, {teamC, "C"}} {
		if err := s.UpsertTagInfo(orgID, tc.id, tc.name, "", 1000); err != nil {
			t.Fatal(err)
		}
	}
	linkTag(t, s, orgID, orgID, deptA, "A", 1)
	linkTag(t, s, orgID, orgID, deptB, "B", 2)
	linkTag(t, s, orgID, deptA, teamC, "C", 1) // C 同时挂 A、B（多父）
	linkTag(t, s, orgID, deptB, teamC, "C", 1)
	addMember(t, s, orgID, deptA, 61, "m", "", TagRankUnset)

	found, err := s.DeleteTagInfo(orgID, deptA, 2000)
	if err != nil || !found {
		t.Fatalf("DeleteTagInfo: %v found=%v", err, found)
	}

	// A 的字典行物理删除；相关边全部墓碑；C 仍可通过 B 展开。
	tag, err := s.GetTagInfo(orgID, deptA)
	if err != nil || tag != nil {
		t.Fatalf("deptA tag_info should be gone: %+v err=%v", tag, err)
	}
	rootItems, err := s.ListTagsPage(orgID, orgID, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rootItems) != 1 || rootItems[0].ChildID != deptB {
		t.Fatalf("root should only contain deptB: %+v", rootItems)
	}
	bItems, err := s.ListTagsPage(orgID, deptB, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(bItems) != 1 || bItems[0].ChildID != teamC {
		t.Fatalf("deptB should still contain teamC: %+v", bItems)
	}
	// 成员 61 的唯一边随 A 墓碑 → 不再在职。
	uids, err := s.ActiveMemberUIDs(orgID)
	if err != nil {
		t.Fatal(err)
	}
	if len(uids) != 0 {
		t.Errorf("member should be gone: %v", uids)
	}
	// 组织根不在 tag_info 中：对根 id 调用 DeleteTagInfo 天然无匹配行，安全 no-op。
	if found, err := s.DeleteTagInfo(orgID, orgID, 2000); err != nil || found {
		t.Errorf("deleting root id via DeleteTagInfo should no-op: found=%v err=%v", found, err)
	}
}

// TestOrgCycleCheck 验证防环 BFS 与自环判定。
func TestOrgCycleCheck(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const a, b, c = 601, 602, 603
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{a, b, c} {
		if err := s.UpsertTagInfo(orgID, id, "t", "", 1000); err != nil {
			t.Fatal(err)
		}
	}
	linkTag(t, s, orgID, a, b, "b", 1)
	linkTag(t, s, orgID, b, c, "c", 1)

	// c → a 会成环（a→b→c→a）；a → c 不会（DAG 多父）。
	cycle, err := s.WouldCreateCycle(orgID, c, a)
	if err != nil || !cycle {
		t.Errorf("c->a should cycle: %v %v", cycle, err)
	}
	cycle, err = s.WouldCreateCycle(orgID, a, c)
	if err != nil || cycle {
		t.Errorf("a->c should not cycle: %v %v", cycle, err)
	}
	if cycle, _ := s.WouldCreateCycle(orgID, a, a); !cycle {
		t.Error("self link should cycle")
	}
}

// TestOrgRenameCascadeAndMemberSortKeys 验证改名级联刷边投影、昵称变化刷成员边投影，均 bump seq。
func TestOrgRenameCascadeAndMemberSortKeys(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const dept = 701
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTagInfo(orgID, dept, "旧名", "", 1000); err != nil {
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, dept, "旧名", TagRankUnset)
	addMember(t, s, orgID, dept, 71, "OldNick", "", TagRankUnset)
	_, maxSeqBefore, err := s.GetVersion(orgID)
	if err != nil {
		t.Fatal(err)
	}

	// 改 tag 名 → 被挂边 sort_key bump 一次。
	if err := s.RenameTagInfo(orgID, dept, "新名", "", 2000); err != nil {
		t.Fatal(err)
	}
	rootItems, _ := s.ListTagsPage(orgID, orgID, nil, false, 10)
	if rootItems[0].SortKey != ContactSortKey("", "新名") {
		t.Errorf("edge sort_key not cascaded: %+v", rootItems[0])
	}

	// 昵称变化 → 成员边投影刷新。
	changed, err := s.UpdateMemberSortKeys(orgID, 71, ContactSortKey("", "NewNick"), 3000)
	if err != nil || changed != 1 {
		t.Fatalf("UpdateMemberSortKeys: %v changed=%d", err, changed)
	}
	deptItems, _ := s.ListTagsPage(orgID, dept, nil, false, 10)
	if deptItems[0].SortKey != "newnick" {
		t.Errorf("member sort_key not refreshed: %+v", deptItems[0])
	}
	_, maxSeqAfter, err := s.GetVersion(orgID)
	if err != nil {
		t.Fatal(err)
	}
	if maxSeqAfter <= maxSeqBefore {
		t.Errorf("seq should advance: before=%d after=%d", maxSeqBefore, maxSeqAfter)
	}
}

// TestOrgPurgeAndWaterline 验证 Purge 三步：快照 tombstone 最大 seq → 物理删除 → 升水位线。
// tag_info 字典行本身无 tombstone（物理删），Purge 只清 org_relation。
func TestOrgPurgeAndWaterline(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const dept = 801
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTagInfo(orgID, dept, "dept", "", 1000); err != nil {
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, dept, "dept", 1)
	if found, err := s.DeleteTagInfo(orgID, dept, 2000); err != nil || !found {
		t.Fatalf("DeleteTagInfo: %v", err)
	}

	orgs, err := s.ListPurgeable(10, 0)
	if err != nil || len(orgs) != 1 || orgs[0] != orgID {
		t.Fatalf("ListPurgeable: %v %v", orgs, err)
	}
	deleted, err := s.Purge(orgID)
	if err != nil || deleted != 1 { // 仅 root->dept 这一条边
		t.Fatalf("Purge: deleted=%d err=%v", deleted, err)
	}
	gcSafe, maxSeq, err := s.GetVersion(orgID)
	if err != nil {
		t.Fatal(err)
	}
	if gcSafe == 0 || gcSafe > maxSeq {
		t.Errorf("waterline wrong: gcSafe=%d maxSeq=%d", gcSafe, maxSeq)
	}
	// 幂等：再次 Purge 无事发生，水位线不回退。
	if n, err := s.Purge(orgID); err != nil || n != 0 {
		t.Errorf("second purge: n=%d err=%v", n, err)
	}
	gcSafe2, _, _ := s.GetVersion(orgID)
	if gcSafe2 != gcSafe {
		t.Errorf("waterline should not move: %d -> %d", gcSafe, gcSafe2)
	}
}

// TestOrgCanManageRootGrantCoversWholeOrg 验证组织根 GRANT 递归覆盖任意深度节点。
func TestOrgCanManageRootGrantCoversWholeOrg(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const dept, team = 901, 902
	const rootAdmin, outsider int64 = 11, 12
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ id int64 }{{dept}, {team}} {
		if err := s.UpsertTagInfo(orgID, tc.id, "t", "", 1000); err != nil {
			t.Fatal(err)
		}
	}
	linkTag(t, s, orgID, orgID, dept, "dept", 1)
	linkTag(t, s, orgID, dept, team, "team", 1)
	grantAdmin(t, s, orgID, orgID, rootAdmin)

	for _, tagID := range []int64{orgID, dept, team} {
		ok, err := s.CanManage(orgID, tagID, rootAdmin)
		if err != nil || !ok {
			t.Errorf("root admin should manage tag=%d: ok=%v err=%v", tagID, ok, err)
		}
	}
	ok, err := s.CanManage(orgID, team, outsider)
	if err != nil || ok {
		t.Errorf("outsider should not manage team: ok=%v err=%v", ok, err)
	}
}

// TestOrgCanManageSubtreeGrantScoped 验证挂在部门节点的 GRANT 只递归覆盖自己的子树，
// 管不到兄弟部门，也管不到组织根本身。
func TestOrgCanManageSubtreeGrantScoped(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const deptA, teamA1, deptB int64 = 911, 912, 913
	const deptAAdmin int64 = 21
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{deptA, teamA1, deptB} {
		if err := s.UpsertTagInfo(orgID, id, "t", "", 1000); err != nil {
			t.Fatal(err)
		}
	}
	linkTag(t, s, orgID, orgID, deptA, "A", 1)
	linkTag(t, s, orgID, deptA, teamA1, "A1", 1)
	linkTag(t, s, orgID, orgID, deptB, "B", 2)
	grantAdmin(t, s, orgID, deptA, deptAAdmin)

	if ok, err := s.CanManage(orgID, deptA, deptAAdmin); err != nil || !ok {
		t.Errorf("deptA admin should manage deptA itself: ok=%v err=%v", ok, err)
	}
	if ok, err := s.CanManage(orgID, teamA1, deptAAdmin); err != nil || !ok {
		t.Errorf("deptA admin should manage its child teamA1: ok=%v err=%v", ok, err)
	}
	if ok, err := s.CanManage(orgID, deptB, deptAAdmin); err != nil || ok {
		t.Errorf("deptA admin should not manage sibling deptB: ok=%v err=%v", ok, err)
	}
	if ok, err := s.CanManage(orgID, orgID, deptAAdmin); err != nil || ok {
		t.Errorf("deptA admin should not manage org root: ok=%v err=%v", ok, err)
	}
}

// TestOrgGrantRevokeAndListAdmins 验证 GRANT/撤权与 ListGrantedAdmins，
// 且 GRANT 行不出现在展开（ListTagsPage）与同步（SyncPage）结果里。
func TestOrgGrantRevokeAndListAdmins(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const admin1, admin2 int64 = 31, 32
	if err := s.UpsertOrgInfo(orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	grantAdmin(t, s, orgID, orgID, admin1)
	grantAdmin(t, s, orgID, orgID, admin2)

	admins, err := s.ListGrantedAdmins(orgID, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if len(admins) != 2 {
		t.Fatalf("want 2 admins, got %+v", admins)
	}

	// GRANT 行不进入展开结果（根下无 PERSON/TAG 子项，展开应为空）。
	rootItems, err := s.ListTagsPage(orgID, orgID, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rootItems) != 0 {
		t.Errorf("GRANT rows should not appear in expand: %+v", rootItems)
	}
	// GRANT 行不进入同步结果。
	syncRows, hasMore, err := s.SyncPage(orgID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(syncRows) != 0 || hasMore {
		t.Errorf("GRANT rows should not appear in sync: rows=%+v hasMore=%v", syncRows, hasMore)
	}

	// 撤销 admin1 后仅剩 admin2。
	removed, _, err := s.RemoveTag(orgID, orgID, admin1, TagChildGrant, 2000)
	if err != nil || !removed {
		t.Fatalf("revoke admin1: removed=%v err=%v", removed, err)
	}
	admins, err = s.ListGrantedAdmins(orgID, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if len(admins) != 1 || admins[0] != admin2 {
		t.Errorf("want only admin2 left, got %+v", admins)
	}
	if ok, err := s.CanManage(orgID, orgID, admin1); err != nil || ok {
		t.Errorf("revoked admin1 should no longer manage: ok=%v err=%v", ok, err)
	}
}
