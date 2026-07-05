package dal

import (
	"testing"
	"yimsg/internal/shard"
)

func setupDB(t *testing.T) *shard.Database {
	t.Helper()
	db, err := shard.OpenMemory(1, Schemas())
	if err != nil {
		t.Fatalf("OpenMemory: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
