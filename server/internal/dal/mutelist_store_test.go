package dal

import "testing"

func TestMutelistStoreUpsertListSync(t *testing.T) {
	db := setupDB(t)
	store := NewMutelistStore(db.UIDShards.AllShards()[0])

	seq1, err := store.Upsert(1, 2, 0, true, 1000)
	if err != nil || seq1 != 1 {
		t.Fatalf("Upsert true = %d, err=%v", seq1, err)
	}
	seq2, err := store.Upsert(1, 2, 0, false, 1001)
	if err != nil || seq2 != 2 {
		t.Fatalf("Upsert false = %d, err=%v", seq2, err)
	}

	entry, err := store.Get(1, 2, 0)
	if err != nil || entry == nil || entry.Status != MutelistDeleted {
		t.Fatalf("Get = %+v, err=%v", entry, err)
	}

	list, err := store.List(1, 0, 10)
	if err != nil || len(list) != 0 {
		t.Fatalf("List = %+v, err=%v", list, err)
	}

	sync, err := store.Sync(1, 0, 10)
	if err != nil || len(sync) != 1 || sync[0].Seq != seq2 || sync[0].Status != MutelistDeleted {
		t.Fatalf("Sync = %+v, err=%v", sync, err)
	}

	seq3, err := store.Upsert(1, 0, 100, true, 1002)
	if err != nil || seq3 != 3 {
		t.Fatalf("Upsert group = %d, err=%v", seq3, err)
	}
	list, err = store.List(1, 0, 10)
	if err != nil || len(list) != 1 || list[0].GroupID != 100 || list[0].Status != MutelistActive {
		t.Fatalf("List after group mutelist = %+v, err=%v", list, err)
	}

	purged, err := store.Purge(1)
	if err != nil || purged != 1 {
		t.Fatalf("Purge = %d, err=%v", purged, err)
	}
	gcSafeSeq, maxSeq, err := store.GetVersion(1)
	if err != nil {
		t.Fatalf("GetVersion: %v", err)
	}
	if gcSafeSeq != seq2 || maxSeq != seq3 {
		t.Fatalf("version after purge = gc_safe:%d max:%d, want %d/%d", gcSafeSeq, maxSeq, seq2, seq3)
	}
}
