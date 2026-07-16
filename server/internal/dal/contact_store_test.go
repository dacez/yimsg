package dal

import "testing"

// upsertC 是测试辅助：基于 remark 与展示名算好排序/搜索投影后写入。
func upsertC(store *ContactStore, uid, friendUID, groupID int64, status uint8, remark, display string, now int64) (int64, error) {
	return store.Upsert(uid, friendUID, groupID, 0, status, remark, ContactSortKey(remark, display), ContactSearchText(remark, display), now)
}

func TestUpsertAndList(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	seq1, err := upsertC(store, 1, 2, 0, ContactPendingIncoming, "", "Charlie", 1000)
	if err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if seq1 != 1 {
		t.Errorf("first upsert: seq %d, want 1", seq1)
	}

	seq2, err := upsertC(store, 1, 3, 0, ContactPendingIncoming, "Bob", "Alice", 1000)
	if err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if seq2 != 2 {
		t.Errorf("second upsert: seq %d, want 2", seq2)
	}

	// List 返回未删除联系人，按 sort_key 排序。
	contacts, err := store.List(1, 100)
	if err != nil {
		t.Fatalf("ListContacts: %v", err)
	}
	if len(contacts) != 2 {
		t.Fatalf("got %d contacts, want 2", len(contacts))
	}
	// sort_key: friend3="bob" < friend2="charlie"
	if contacts[0].FriendUID != 3 || contacts[1].FriendUID != 2 {
		t.Errorf("wrong order: %+v", contacts)
	}
	if contacts[0].SortKey != "bob" || contacts[1].SortKey != "charlie" {
		t.Errorf("wrong sort_key: %+v", contacts)
	}
	if contacts[0].SearchText != "Bob Alice" || contacts[1].SearchText != "Charlie" {
		t.Errorf("wrong search_text: %+v", contacts)
	}
	if contacts[0].CreatedAt != 1000 || contacts[0].UpdatedAt != 1000 {
		t.Errorf("created_at/updated_at not written: %+v", contacts[0])
	}
	total, err := store.Count(1, ContactListFilter{})
	if err != nil {
		t.Fatalf("CountContacts: %v", err)
	}
	if total != 2 {
		t.Errorf("total = %d, want 2", total)
	}
}

func TestListFilteredOrdersPendingByNewestSeq(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	if _, err := upsertC(store, 1, 2, 0, ContactPendingIncoming, "", "Charlie", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if _, err := upsertC(store, 1, 3, 0, ContactPendingIncoming, "", "Alice", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if _, err := upsertC(store, 1, 4, 0, ContactPendingIncoming, "", "Bob", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}

	status := ContactPendingIncoming
	contacts, err := store.ListPage(1, ContactListFilter{Status: &status}, nil, false, 100)
	if err != nil {
		t.Fatalf("ListFiltered pending: %v", err)
	}
	if len(contacts) != 3 {
		t.Fatalf("got %d contacts, want 3", len(contacts))
	}
	got := []int64{contacts[0].FriendUID, contacts[1].FriendUID, contacts[2].FriendUID}
	want := []int64{4, 3, 2}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("pending order = %v, want %v", got, want)
		}
	}
}

// TestUpdateProjections 覆盖：无备注时昵称变化更新 sort_key/search_text 并 bump seq；
// 有备注时昵称变化不覆盖 sort_key，但因为 search_text 含昵称，仍更新 search_text 并 bump seq。
func TestUpdateProjections(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	if _, err := upsertC(store, 1, 2, 0, ContactFriend, "", "Bob", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if _, err := upsertC(store, 1, 3, 0, ContactFriend, "CarolRemark", "Carol", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	changed, err := store.UpdateFriendProjections(1, map[int64]string{2: "Bobby", 3: "CarolNew"}, 2000)
	if err != nil {
		t.Fatalf("UpdateFriendProjections: %v", err)
	}
	// 两条都变：friend2 sort+search 都变；friend3 sort 不变但 search 含新昵称而变。
	if changed != 2 {
		t.Fatalf("changed = %d, want 2", changed)
	}
	c2, _ := store.Get(1, 2)
	if c2.SortKey != "bobby" || c2.SearchText != "Bobby" {
		t.Errorf("friend 2 not refreshed: %+v", c2)
	}
	// 两条都 bump 了 seq（原 seq 为 1、2），新 seq 必然 > 2 且彼此不同；
	// 批量内具体先后由 map 迭代顺序决定，不做顺序断言。
	if c2.Seq <= 2 || c2.UpdatedAt != 2000 {
		t.Errorf("friend 2 seq/updated_at not bumped: %+v", c2)
	}
	c3, _ := store.Get(1, 3)
	if c3.SortKey != "carolremark" {
		t.Errorf("remarked contact sort_key should not change: %+v", c3)
	}
	if c3.SearchText != "CarolRemark CarolNew" || c3.Seq <= 2 {
		t.Errorf("remarked contact search_text should refresh and bump seq: %+v", c3)
	}
	if c2.Seq == c3.Seq {
		t.Errorf("bumped seqs must be distinct: c2=%d c3=%d", c2.Seq, c3.Seq)
	}
}

// TestUpdateRemarkRecomputesProjections 覆盖：备注更新会重算 sort_key/search_text 并 bump seq。
func TestUpdateRemarkRecomputesProjections(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	if _, err := upsertC(store, 1, 2, 0, ContactFriend, "", "Bob", 1000); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	ok, err := store.UpdateRemark(1, 2, 0, 0, "Boss", ContactSortKey("Boss", "Bob"), ContactSearchText("Boss", "Bob"), 3000)
	if err != nil || !ok {
		t.Fatalf("UpdateRemark: ok=%v err=%v", ok, err)
	}
	c2, _ := store.Get(1, 2)
	if c2.RemarkName != "Boss" || c2.SortKey != "boss" || c2.SearchText != "Boss Bob" {
		t.Errorf("remark not applied with projections: %+v", c2)
	}
	if c2.Seq != 2 || c2.UpdatedAt != 3000 {
		t.Errorf("remark should bump seq and updated_at: %+v", c2)
	}
}

func TestContactStoreDelete(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	upsertC(store, 1, 2, 0, ContactFriend, "Alice", "Alice", 1000)

	seq, found, err := store.Delete(1, 2, 0, 0)
	if err != nil {
		t.Fatalf("Delete contact row: %v", err)
	}
	if !found {
		t.Error("should find existing contact")
	}
	if seq <= 0 {
		t.Fatalf("delete seq = %d, want > 0", seq)
	}

	c, _ := store.Get(1, 2)
	if c == nil || c.Status != ContactDeleted {
		t.Errorf("should be soft-deleted: %+v", c)
	}

	contacts, _ := store.List(1, 100)
	if len(contacts) != 0 {
		t.Errorf("deleted contact should not appear in list, got %d", len(contacts))
	}

	_, found, err = store.Delete(1, 999, 0, 0)
	if err != nil {
		t.Fatalf("Delete nonexistent contact row: %v", err)
	}
	if found {
		t.Error("should not find nonexistent contact")
	}
}

func TestAcceptRejectRequest(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	upsertC(store, 1, 2, 0, ContactPendingIncoming, "", "Bob", 1000)
	ok, err := store.AcceptRequest(1, 2)
	if err != nil {
		t.Fatalf("AcceptRequest: %v", err)
	}
	if !ok {
		t.Error("should accept pending request")
	}
	c, _ := store.Get(1, 2)
	if c.Status != ContactFriend {
		t.Errorf("status should be Friend, got %d", c.Status)
	}

	upsertC(store, 1, 3, 0, ContactPendingIncoming, "", "Carol", 1000)
	ok, err = store.RejectRequest(1, 3)
	if err != nil {
		t.Fatalf("RejectRequest: %v", err)
	}
	if !ok {
		t.Error("should reject pending request")
	}

	ok, _ = store.AcceptRequest(1, 999)
	if ok {
		t.Error("should not accept nonexistent")
	}
}

// TestAcceptRequestRejectsOutgoingSide 覆盖好友请求方向 bug 的回归：申请方自身记录是
// PENDING_OUTGOING，不是 PENDING_INCOMING，AcceptRequest/RejectRequest 不应该命中它。
func TestAcceptRequestRejectsOutgoingSide(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	// uid=1 是申请方，自身记录写成 PENDING_OUTGOING（等 uid=2 处理）。
	upsertC(store, 1, 2, 0, ContactPendingOutgoing, "", "Bob", 1000)

	ok, err := store.AcceptRequest(1, 2)
	if err != nil {
		t.Fatalf("AcceptRequest: %v", err)
	}
	if ok {
		t.Error("申请方不应该能对自己发出的请求调用 accept 成功")
	}
	c, _ := store.Get(1, 2)
	if c.Status != ContactPendingOutgoing {
		t.Errorf("状态不应该被改变，got %d", c.Status)
	}

	ok, err = store.RejectRequest(1, 2)
	if err != nil {
		t.Fatalf("RejectRequest: %v", err)
	}
	if ok {
		t.Error("申请方不应该能对自己发出的请求调用 reject 成功")
	}

	// AcceptCounterpartRequest/RejectCounterpartRequest 才是用来翻转申请方自身 OUTGOING 记录的方法。
	ok, err = store.AcceptCounterpartRequest(1, 2)
	if err != nil {
		t.Fatalf("AcceptCounterpartRequest: %v", err)
	}
	if !ok {
		t.Error("AcceptCounterpartRequest 应该能翻转申请方自身的 PENDING_OUTGOING 记录")
	}
	c, _ = store.Get(1, 2)
	if c.Status != ContactFriend {
		t.Errorf("counterpart accept 后状态应为 Friend，got %d", c.Status)
	}
}

func TestContactGC(t *testing.T) {
	db := setupDB(t)
	store := NewContactStore(db.UIDShards.AllShards()[0])

	upsertC(store, 1, 2, 0, ContactFriend, "", "Bob", 1000)
	upsertC(store, 1, 3, 0, ContactFriend, "", "Carol", 1000)
	store.Delete(1, 2, 0, 0) // soft delete

	deleted, err := store.Purge(1)
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if deleted != 1 {
		t.Errorf("should delete 1 soft-deleted contact, got %d", deleted)
	}

	c, _ := store.Get(1, 2)
	if c != nil {
		t.Error("contact 2 should be physically deleted after GC")
	}

	contacts, _ := store.List(1, 100)
	if len(contacts) != 1 || contacts[0].FriendUID != 3 {
		t.Errorf("remaining contacts: %+v", contacts)
	}
}
