package shard

import (
	"fmt"
	"testing"
)

func newTestGroup(n int) *Group {
	shards := make([]*DB, n)
	for i := range shards {
		shards[i] = &DB{} // dummy, only used for pointer identity
	}
	return NewGroup(shards)
}

func TestRouteInt64Consistency(t *testing.T) {
	g := newTestGroup(4)
	for _, key := range []int64{0, 1, 100, 999999, -1, 1 << 53} {
		s1 := g.RouteInt64(key)
		s2 := g.RouteInt64(key)
		if s1 != s2 {
			t.Errorf("key %d routed to different shards", key)
		}
	}
}

func TestRouteStrConsistency(t *testing.T) {
	g := newTestGroup(4)
	keys := []string{"alice", "bob", "charlie", "", "日本語", "a-very-long-string-for-testing"}
	for _, key := range keys {
		s1 := g.RouteStr(key)
		s2 := g.RouteStr(key)
		if s1 != s2 {
			t.Errorf("key %q routed to different shards", key)
		}
	}

	// Check that different keys produce some distribution (at least 2 distinct shards for 6 keys)
	seen := make(map[*DB]bool)
	for _, key := range keys {
		seen[g.RouteStr(key)] = true
	}
	if len(seen) < 2 {
		t.Error("expected at least 2 distinct shards for 6 different keys")
	}
}

func TestShardIndex(t *testing.T) {
	g := newTestGroup(4)
	for _, key := range []int64{0, 1, 2, 3, 4, 100, -1, 1 << 62} {
		idx := g.ShardIndex(key)
		if idx < 0 || idx >= 4 {
			t.Errorf("ShardIndex(%d) = %d, out of range [0, 4)", key, idx)
		}
	}
}

// testSchemas 提供一组最小 DDL，使得 OpenMemory 可以完成建表。
// 这里不依赖 dal 包以避免循环引用。
func testSchemas() map[string]string {
	return map[string]string{
		"uid":      `CREATE TABLE IF NOT EXISTS t_uid (id INTEGER PRIMARY KEY);`,
		"username": `CREATE TABLE IF NOT EXISTS t_username (name TEXT PRIMARY KEY);`,
		"token":    `CREATE TABLE IF NOT EXISTS t_token (tok TEXT PRIMARY KEY);`,
		"group":    `CREATE TABLE IF NOT EXISTS t_group (gid INTEGER PRIMARY KEY);`,
		"org":      `CREATE TABLE IF NOT EXISTS t_org (oid INTEGER PRIMARY KEY);`,
	}
}

// TestOpenMemoryAndClose 验证 OpenMemory 能为五组分片完成建表，
// 并且 Database.Close 可正常释放所有连接。
func TestOpenMemoryAndClose(t *testing.T) {
	const n = 3
	db, err := OpenMemory(n, testSchemas())
	if err != nil {
		t.Fatalf("OpenMemory: %v", err)
	}

	for name, g := range map[string]*Group{
		"uid":      db.UIDShards,
		"username": db.UsernameShards,
		"token":    db.TokenShards,
		"group":    db.GroupShards,
		"org":      db.OrgShards,
	} {
		if g == nil {
			t.Fatalf("%s group is nil", name)
		}
		if g.Count() != n {
			t.Errorf("%s: Count() = %d, want %d", name, g.Count(), n)
		}
		if got := len(g.AllShards()); got != n {
			t.Errorf("%s: AllShards len = %d, want %d", name, got, n)
		}
		// 每个分片的 Writer/Reader 均应可用（Ping）。
		for i, s := range g.AllShards() {
			if s == nil || s.Writer == nil || s.Reader == nil {
				t.Fatalf("%s shard %d missing connection", name, i)
			}
			if err := s.Writer.Ping(); err != nil {
				t.Errorf("%s shard %d writer ping: %v", name, i, err)
			}
			if err := s.Reader.Ping(); err != nil {
				t.Errorf("%s shard %d reader ping: %v", name, i, err)
			}
		}
	}

	// Close 必须成功且幂等（Close 返回第一个错误即可）。
	if err := db.Close(); err != nil {
		t.Fatalf("Database.Close: %v", err)
	}
	// 关闭后再 Ping 应当失败，从侧面验证连接已经关闭。
	if err := db.UIDShards.AllShards()[0].Writer.Ping(); err == nil {
		t.Error("writer should be closed after Database.Close")
	}
}

// TestOpenMemoryWritesPersistPerShard 验证相同键写入后可从同一分片读取，
// 不同键的数据互不干扰，间接验证路由一致性。
func TestOpenMemoryWritesPersistPerShard(t *testing.T) {
	db, err := OpenMemory(4, testSchemas())
	if err != nil {
		t.Fatalf("OpenMemory: %v", err)
	}
	defer db.Close()

	keys := []int64{1, 2, 3, 10, 100, 1234567}
	for _, k := range keys {
		s := db.UIDShards.RouteInt64(k)
		if _, err := s.Writer.Exec("INSERT INTO t_uid(id) VALUES(?)", k); err != nil {
			t.Fatalf("insert %d: %v", k, err)
		}
	}
	for _, k := range keys {
		s := db.UIDShards.RouteInt64(k)
		var got int64
		if err := s.Reader.QueryRow("SELECT id FROM t_uid WHERE id = ?", k).Scan(&got); err != nil {
			t.Fatalf("select %d: %v", k, err)
		}
		if got != k {
			t.Errorf("got %d, want %d", got, k)
		}
	}

	// AllShards 中每个分片的总条数加起来应当等于写入总数。
	total := 0
	for _, s := range db.UIDShards.AllShards() {
		var c int
		if err := s.Reader.QueryRow("SELECT COUNT(*) FROM t_uid").Scan(&c); err != nil {
			t.Fatalf("count: %v", err)
		}
		total += c
	}
	if total != len(keys) {
		t.Errorf("sum across shards = %d, want %d", total, len(keys))
	}
}

// TestRouteStrPointsToAllShardsMember 验证 RouteStr 返回的分片一定存在于 AllShards 中。
func TestRouteStrPointsToAllShardsMember(t *testing.T) {
	g := newTestGroup(8)
	all := g.AllShards()
	set := make(map[*DB]bool, len(all))
	for _, s := range all {
		set[s] = true
	}
	for _, key := range []string{"a", "b", "日本語", "", "longer-key-xxxx"} {
		s := g.RouteStr(key)
		if !set[s] {
			t.Errorf("RouteStr(%q) returned shard not in AllShards", key)
		}
	}
}

// TestRouteStrDistribution 验证 FNV 哈希对大量键有合理的分布（非严格均匀性）。
func TestRouteStrDistribution(t *testing.T) {
	g := newTestGroup(4)
	counts := make(map[*DB]int)
	for i := 0; i < 4000; i++ {
		counts[g.RouteStr(fmt.Sprintf("key-%d", i))]++
	}
	if len(counts) != 4 {
		t.Errorf("expected all 4 shards to receive at least one key, got %d", len(counts))
	}
	for s, c := range counts {
		if c == 0 {
			t.Errorf("shard %p received 0 keys", s)
		}
	}
}
