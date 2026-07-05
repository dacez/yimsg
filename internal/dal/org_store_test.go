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
	seq, hadActive, err := s.UpsertItem(orgID, tagID, 0, uid, title, rank, ContactSortKey("", nickname), 1000)
	if err != nil {
		t.Fatalf("UpsertItem uid=%d: %v", uid, err)
	}
	return seq, hadActive
}

// linkTag 是测试辅助：按 tag 名算好 sort_key 后把子 tag 挂进父 tag。
func linkTag(t *testing.T, s *OrgStore, orgID, parentTagID, childTagID int64, name string, rank int64) {
	t.Helper()
	if _, _, err := s.UpsertItem(orgID, parentTagID, childTagID, 0, "", rank, ContactSortKey("", name), 1000); err != nil {
		t.Fatalf("UpsertItem child=%d: %v", childTagID, err)
	}
}

// TestOrgExpandAbsoluteOrder 验证展开排序：rank 优先、sort_key 次之、child_tag_id/uid 兜底，
// 子 tag 与人混排，且仅返回 ACTIVE 行。
func TestOrgExpandAbsoluteOrder(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if _, err := s.UpsertTag(orgID, orgID, "广州研发中心", "", 1000); err != nil {
		t.Fatalf("UpsertTag root: %v", err)
	}
	if _, err := s.UpsertTag(orgID, 201, "秘书处", "", 1000); err != nil {
		t.Fatalf("UpsertTag: %v", err)
	}

	// 领导 1/2 显式 rank；员工按名字排；子 tag 沉底（rank 编排到人之后）。
	addMember(t, s, orgID, orgID, 11, "Zed", "领导1", 10)
	addMember(t, s, orgID, orgID, 12, "Amy", "领导2", 20)
	addMember(t, s, orgID, orgID, 13, "Carol", "", OrgRankUnset)
	addMember(t, s, orgID, orgID, 14, "bob", "", OrgRankUnset)
	linkTag(t, s, orgID, orgID, 201, "秘书处", 900000)

	rows, err := s.ListItemsPage(orgID, orgID, nil, false, 10)
	if err != nil {
		t.Fatalf("ListItemsPage: %v", err)
	}
	wantUIDs := []int64{11, 12, 0, 14, 13} // 领导1、领导2、秘书处(rank=900000)、bob、carol
	if len(rows) != len(wantUIDs) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(wantUIDs), rows)
	}
	for i, want := range wantUIDs {
		if rows[i].UID != want {
			t.Errorf("row %d: uid=%d want %d (%+v)", i, rows[i].UID, want, rows[i])
		}
	}
	if rows[2].ChildTagID != 201 {
		t.Errorf("row 2 should be child tag 201, got %+v", rows[2])
	}
}

// TestOrgExpandKeysetPaging 验证 keyset 翻页无重无漏。
func TestOrgExpandKeysetPaging(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if _, err := s.UpsertTag(orgID, orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	names := []string{"a", "b", "c", "d", "e"}
	for i, n := range names {
		addMember(t, s, orgID, orgID, int64(20+i), n, "", OrgRankUnset)
	}

	first, err := s.ListItemsPage(orgID, orgID, nil, false, 2)
	if err != nil || len(first) != 2 {
		t.Fatalf("first page: %v %d", err, len(first))
	}
	// 游标即上一页末行的 keyset 字段 [rank, sort_key, child_tag_id, uid]。
	last := first[1]
	cursor := []string{
		strconv.FormatInt(last.Rank, 10), last.SortKey,
		strconv.FormatInt(last.ChildTagID, 10), strconv.FormatInt(last.UID, 10),
	}
	second, err := s.ListItemsPage(orgID, orgID, cursor, false, 10)
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
	if _, err := s.UpsertTag(orgID, orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTag(orgID, leadersTag, "公司领导", "", 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTag(orgID, deptTag, "xx部门", "", 1000); err != nil {
		t.Fatal(err)
	}

	// A（名字靠后）在公司领导未显式排序 → 按名字沉底；在 xx 部门 rank=1 排第一。
	_, had := addMember(t, s, orgID, leadersTag, 41, "zz-A", "", OrgRankUnset)
	if had {
		t.Error("first edge should report hadActive=false")
	}
	addMember(t, s, orgID, leadersTag, 42, "aa-B", "", OrgRankUnset)
	_, had = addMember(t, s, orgID, deptTag, 41, "zz-A", "部门负责人", 1)
	if !had {
		t.Error("second edge should report hadActive=true")
	}
	addMember(t, s, orgID, deptTag, 43, "aa-C", "", OrgRankUnset)

	leaders, err := s.ListItemsPage(orgID, leadersTag, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if leaders[len(leaders)-1].UID != 41 {
		t.Errorf("A should be last in leaders tag: %+v", leaders)
	}
	dept, err := s.ListItemsPage(orgID, deptTag, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if dept[0].UID != 41 {
		t.Errorf("A should be first in dept tag: %+v", dept)
	}
}

// TestOrgSyncPageMergedCursor 验证节点与边共用 seq 空间：单游标合并翻页、tombstone 可见。
func TestOrgSyncPageMergedCursor(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	if _, err := s.UpsertTag(orgID, orgID, "org", "", 1000); err != nil { // seq 1
		t.Fatal(err)
	}
	if _, err := s.UpsertTag(orgID, 401, "dept", "", 1000); err != nil { // seq 2
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, 401, "dept", 100)           // seq 3
	addMember(t, s, orgID, 401, 51, "n1", "", OrgRankUnset) // seq 4

	// 全量第一页 limit=2：应拿到 seq 1、2（两个节点），has_more。
	tags, items, hasMore, err := s.SyncPage(orgID, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 2 || len(items) != 0 || !hasMore {
		t.Fatalf("page1 tags=%d items=%d hasMore=%v", len(tags), len(items), hasMore)
	}
	// 第二页从 seq 2 之后：seq 3、4（两条边），无更多。
	tags, items, hasMore, err = s.SyncPage(orgID, tags[1].Seq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 0 || len(items) != 2 || hasMore {
		t.Fatalf("page2 tags=%d items=%d hasMore=%v", len(tags), len(items), hasMore)
	}

	// 摘人 → tombstone 进入增量流。
	lastSeq := items[1].Seq
	removed, still, err := s.RemoveItem(orgID, 401, 0, 51, 2000)
	if err != nil || !removed || still {
		t.Fatalf("RemoveItem: %v removed=%v still=%v", err, removed, still)
	}
	_, items, _, err = s.SyncPage(orgID, lastSeq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Status != OrgTagDeleted {
		t.Fatalf("tombstone not synced: %+v", items)
	}
}

// TestOrgDeleteTagCascade 验证删 tag 级联墓碑两个方向的边，且 DAG 中被挂在别处的子节点不受影响。
func TestOrgDeleteTagCascade(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const deptA, deptB, teamC = 501, 502, 503
	for _, tc := range []struct {
		id   int64
		name string
	}{{orgID, "org"}, {deptA, "A"}, {deptB, "B"}, {teamC, "C"}} {
		if _, err := s.UpsertTag(orgID, tc.id, tc.name, "", 1000); err != nil {
			t.Fatal(err)
		}
	}
	linkTag(t, s, orgID, orgID, deptA, "A", 1)
	linkTag(t, s, orgID, orgID, deptB, "B", 2)
	linkTag(t, s, orgID, deptA, teamC, "C", 1) // C 同时挂 A、B（多父）
	linkTag(t, s, orgID, deptB, teamC, "C", 1)
	addMember(t, s, orgID, deptA, 61, "m", "", OrgRankUnset)

	found, err := s.DeleteTag(orgID, deptA, 2000)
	if err != nil || !found {
		t.Fatalf("DeleteTag: %v found=%v", err, found)
	}

	// A 的节点与相关边全部墓碑；C 仍可通过 B 展开。
	tag, err := s.GetTag(orgID, deptA)
	if err != nil || tag == nil || tag.Status != OrgTagDeleted {
		t.Fatalf("deptA should be tombstoned: %+v err=%v", tag, err)
	}
	rootItems, err := s.ListItemsPage(orgID, orgID, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rootItems) != 1 || rootItems[0].ChildTagID != deptB {
		t.Fatalf("root should only contain deptB: %+v", rootItems)
	}
	bItems, err := s.ListItemsPage(orgID, deptB, nil, false, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(bItems) != 1 || bItems[0].ChildTagID != teamC {
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
	// 根 tag 不允许删除。
	if _, err := s.DeleteTag(orgID, orgID, 2000); err == nil {
		t.Error("deleting root tag should fail")
	}
}

// TestOrgCycleCheck 验证防环 BFS 与自环判定。
func TestOrgCycleCheck(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const a, b, c = 601, 602, 603
	for _, id := range []int64{orgID, a, b, c} {
		if _, err := s.UpsertTag(orgID, id, "t", "", 1000); err != nil {
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
	if _, err := s.UpsertTag(orgID, orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTag(orgID, dept, "旧名", "", 1000); err != nil {
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, dept, "旧名", OrgRankUnset)
	addMember(t, s, orgID, dept, 71, "OldNick", "", OrgRankUnset)
	_, maxSeqBefore, err := s.GetVersion(orgID)
	if err != nil {
		t.Fatal(err)
	}

	// 改 tag 名 → 节点行 + 被挂边 sort_key 各 bump 一次。
	if _, err := s.UpsertTag(orgID, dept, "新名", "", 2000); err != nil {
		t.Fatal(err)
	}
	rootItems, _ := s.ListItemsPage(orgID, orgID, nil, false, 10)
	if rootItems[0].SortKey != ContactSortKey("", "新名") {
		t.Errorf("edge sort_key not cascaded: %+v", rootItems[0])
	}

	// 昵称变化 → 成员边投影刷新。
	changed, err := s.UpdateMemberSortKeys(orgID, 71, ContactSortKey("", "NewNick"), 3000)
	if err != nil || changed != 1 {
		t.Fatalf("UpdateMemberSortKeys: %v changed=%d", err, changed)
	}
	deptItems, _ := s.ListItemsPage(orgID, dept, nil, false, 10)
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
func TestOrgPurgeAndWaterline(t *testing.T) {
	s := orgStore(t)
	const orgID = 100
	const dept = 801
	if _, err := s.UpsertTag(orgID, orgID, "org", "", 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTag(orgID, dept, "dept", "", 1000); err != nil {
		t.Fatal(err)
	}
	linkTag(t, s, orgID, orgID, dept, "dept", 1)
	if found, err := s.DeleteTag(orgID, dept, 2000); err != nil || !found {
		t.Fatalf("DeleteTag: %v", err)
	}

	orgs, err := s.ListPurgeable(10, 0)
	if err != nil || len(orgs) != 1 || orgs[0] != orgID {
		t.Fatalf("ListPurgeable: %v %v", orgs, err)
	}
	deleted, err := s.Purge(orgID)
	if err != nil || deleted != 2 { // 节点 + 边各 1 行
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
