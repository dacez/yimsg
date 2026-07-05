package dal

import (
	"database/sql"
	"testing"
)

func TestBumpUserSequenceHelpersShareMonotonicBehavior(t *testing.T) {
	db := setupDB(t)
	shardDB := db.UIDShards.AllShards()[0]

	err := withTx(shardDB.Writer, func(tx *sql.Tx) error {
		contactSeq1, err := bumpContactSeq(tx, 1)
		if err != nil {
			return err
		}
		contactSeq2, err := bumpContactSeq(tx, 1)
		if err != nil {
			return err
		}
		blocklistSeq, err := bumpBlocklistSeq(tx, 1)
		if err != nil {
			return err
		}
		muteSeq, err := bumpMutelistSeq(tx, 1)
		if err != nil {
			return err
		}
		if contactSeq1 != 1 || contactSeq2 != 2 || blocklistSeq != 1 || muteSeq != 1 {
			t.Fatalf("unexpected seqs: contact=(%d,%d) blocklist=%d mutelist=%d", contactSeq1, contactSeq2, blocklistSeq, muteSeq)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("bump sequence helpers: %v", err)
	}

	err = withTx(shardDB.Writer, func(tx *sql.Tx) error {
		otherUIDSeq, err := bumpContactSeq(tx, 2)
		if err != nil {
			return err
		}
		if otherUIDSeq != 1 {
			t.Fatalf("different uid contact seq = %d, want 1", otherUIDSeq)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("bump sequence helper for another uid: %v", err)
	}
}

func TestBumpUserSequenceRollsBackWithTransaction(t *testing.T) {
	db := setupDB(t)
	shardDB := db.UIDShards.AllShards()[0]

	err := withTx(shardDB.Writer, func(tx *sql.Tx) error {
		if _, err := bumpContactSeq(tx, 1); err != nil {
			return err
		}
		return sql.ErrTxDone
	})
	if err == nil {
		t.Fatal("expected rollback error")
	}

	err = withTx(shardDB.Writer, func(tx *sql.Tx) error {
		seq, err := bumpContactSeq(tx, 1)
		if err != nil {
			return err
		}
		if seq != 1 {
			t.Fatalf("seq after rollback = %d, want 1", seq)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("bump after rollback: %v", err)
	}
}
