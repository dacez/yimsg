package dal

import "testing"

func TestBlocklistStoreUpsertListSyncDelete(t *testing.T) {
	db := setupDB(t)
	store := NewBlocklistStore(db.UIDShards.AllShards()[0])

	seq1, err := store.Upsert(1, 2, 1000)
	if err != nil || seq1 != 1 {
		t.Fatalf("Upsert seq1 = %d, err=%v", seq1, err)
	}
	seq2, err := store.Upsert(1, 3, 1001)
	if err != nil || seq2 != 2 {
		t.Fatalf("Upsert seq2 = %d, err=%v", seq2, err)
	}

	list, err := store.List(1, 0, 10)
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %+v, err=%v", list, err)
	}

	ok, err := store.IsBlocked(1, 2)
	if err != nil || !ok {
		t.Fatalf("IsBlocked = %v, err=%v", ok, err)
	}

	sync, err := store.Sync(1, 0, 10)
	if err != nil || len(sync) != 2 {
		t.Fatalf("Sync = %+v, err=%v", sync, err)
	}

	deleteSeq, deleted, err := store.Delete(1, 2, 1002)
	if err != nil || !deleted {
		t.Fatalf("Delete = %v, err=%v", deleted, err)
	}
	if deleteSeq <= seq2 {
		t.Fatalf("delete seq = %d, want > %d", deleteSeq, seq2)
	}

	list, err = store.List(1, 0, 10)
	if err != nil || len(list) != 1 || list[0].BlockUID != 3 {
		t.Fatalf("List after delete = %+v, err=%v", list, err)
	}

	sync, err = store.Sync(1, seq2, 10)
	if err != nil || len(sync) != 1 || sync[0].Status != BlocklistDeleted {
		t.Fatalf("Sync after delete = %+v, err=%v", sync, err)
	}

	deletedCount, err := store.Purge(1)
	if err != nil || deletedCount != 1 {
		t.Fatalf("Purge = %d, err=%v", deletedCount, err)
	}
	gcSafeSeq, maxSeq, err := store.GetVersion(1)
	if err != nil {
		t.Fatalf("GetVersion: %v", err)
	}
	if gcSafeSeq != sync[0].Seq || maxSeq != sync[0].Seq {
		t.Fatalf("version after purge = gc_safe:%d max:%d, want %d", gcSafeSeq, maxSeq, sync[0].Seq)
	}
}

func TestBlocklistStoreListFilterAndCount(t *testing.T) {
	db := setupDB(t)
	store := NewBlocklistStore(db.UIDShards.AllShards()[0])
	store.Upsert(1, 2, 1000)
	store.Upsert(1, 3, 1001)
	store.Upsert(1, 4, 1002)

	rows, err := store.ListFiltered(1, BlocklistFilter{UIDs: []int64{2}}, 0, 0, 10)
	if err != nil || len(rows) != 1 || rows[0].BlockUID != 2 {
		t.Fatalf("single filter = %+v, err=%v", rows, err)
	}
	rows, err = store.ListFiltered(1, BlocklistFilter{UIDs: []int64{2, 4}}, 0, 0, 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("batch filter = %+v, err=%v", rows, err)
	}
	total, err := store.Count(1, BlocklistFilter{UIDs: []int64{2, 4}})
	if err != nil || total != 2 {
		t.Fatalf("count = %d, err=%v", total, err)
	}
}
