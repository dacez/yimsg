// Package shard provides sharded SQLite database management.
//
// Each shard has one writer (serialized writes) and a pool of readers (concurrent reads).
// Sharding is done by hash(key) % N for strings or key % N for int64.
package shard

import (
	"database/sql"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

// DB is a single-writer, multi-reader SQLite shard.
type DB struct {
	Writer *sql.DB
	Reader *sql.DB
}

// Group holds N shards and routes keys to the appropriate shard.
type Group struct {
	shards []*DB
}

// Database holds all shard groups used by the application.
type Database struct {
	UIDShards      *Group
	UsernameShards *Group
	TokenShards    *Group
	GroupShards    *Group
	OrgShards      *Group
}

// Close closes both writer and reader connections.
func (db *DB) Close() error {
	werr := db.Writer.Close()
	rerr := db.Reader.Close()
	if werr != nil {
		return werr
	}
	return rerr
}

// Close closes all shards in the group.
func (g *Group) Close() error {
	var first error
	for _, s := range g.shards {
		if err := s.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Close closes all shard groups in the database.
func (d *Database) Close() error {
	var first error
	for _, g := range []*Group{d.UIDShards, d.UsernameShards, d.TokenShards, d.GroupShards, d.OrgShards} {
		if err := g.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// openShard opens a single SQLite shard with WAL mode and pragma tuning.
func openShard(dsn string) (*DB, error) {
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)

	// Apply pragmas via writer
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA cache_size=-65536",
		"PRAGMA wal_autocheckpoint=1000",
	} {
		if _, err := writer.Exec(pragma); err != nil {
			writer.Close()
			return nil, fmt.Errorf("pragma %s: %w", pragma, err)
		}
	}

	reader, err := sql.Open("sqlite", dsn+"?mode=ro")
	if err != nil {
		writer.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(4)

	return &DB{Writer: writer, Reader: reader}, nil
}

// openMemoryShard creates an in-memory SQLite shard using shared-cache URI.
func openMemoryShard(name string) (*DB, error) {
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", name)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, err
		}
	}

	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		db.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(4)

	return &DB{Writer: db, Reader: reader}, nil
}

// NewGroup creates a new shard group.
func NewGroup(shards []*DB) *Group {
	return &Group{shards: shards}
}

// RouteInt64 routes an int64 key to a shard.
func (g *Group) RouteInt64(key int64) *DB {
	idx := int(uint64(key) % uint64(len(g.shards)))
	return g.shards[idx]
}

// RouteStr routes a string key to a shard using FNV hash.
func (g *Group) RouteStr(key string) *DB {
	h := fnv.New64a()
	h.Write([]byte(key))
	idx := int(h.Sum64() % uint64(len(g.shards)))
	return g.shards[idx]
}

// ShardIndex returns the shard index for an int64 key.
func (g *Group) ShardIndex(key int64) int {
	return int(uint64(key) % uint64(len(g.shards)))
}

// AllShards returns all shards in the group.
func (g *Group) AllShards() []*DB {
	return g.shards
}

// Count returns the number of shards.
func (g *Group) Count() int {
	return len(g.shards)
}

// initSchema applies DDL to a shard.
func initSchema(db *DB, ddl string) error {
	_, err := db.Writer.Exec(ddl)
	return err
}

// buildDatabase 用给定的分组打开函数依次打开四类路由分片并组装成 Database。
func buildDatabase(openGroup func(prefix, ddl string) (*Group, error), schemas map[string]string) (*Database, error) {
	uid, err := openGroup("uid", schemas["uid"])
	if err != nil {
		return nil, err
	}
	username, err := openGroup("username", schemas["username"])
	if err != nil {
		return nil, err
	}
	token, err := openGroup("token", schemas["token"])
	if err != nil {
		return nil, err
	}
	group, err := openGroup("group", schemas["group"])
	if err != nil {
		return nil, err
	}
	org, err := openGroup("org", schemas["org"])
	if err != nil {
		return nil, err
	}
	return &Database{
		UIDShards:      uid,
		UsernameShards: username,
		TokenShards:    token,
		GroupShards:    group,
		OrgShards:      org,
	}, nil
}

// Open creates a Database with file-backed shards.
func Open(dataDir string, shardCount int, schemas map[string]string) (*Database, error) {
	openGroup := func(prefix string, ddl string) (*Group, error) {
		shards := make([]*DB, shardCount)
		for i := 0; i < shardCount; i++ {
			path := filepath.Join(dataDir, fmt.Sprintf("%s_%d.db", prefix, i))
			s, err := openShard(path)
			if err != nil {
				return nil, fmt.Errorf("open shard %s_%d: %w", prefix, i, err)
			}
			if err := initSchema(s, ddl); err != nil {
				return nil, fmt.Errorf("schema %s_%d: %w", prefix, i, err)
			}
			shards[i] = s
		}
		return NewGroup(shards), nil
	}

	return buildDatabase(openGroup, schemas)
}

var memCounter int
var memMu sync.Mutex

// OpenMemory creates a Database with in-memory shards for testing.
func OpenMemory(shardCount int, schemas map[string]string) (*Database, error) {
	memMu.Lock()
	base := memCounter
	memCounter += shardCount * 5
	memMu.Unlock()

	openGroup := func(prefix string, ddl string) (*Group, error) {
		shards := make([]*DB, shardCount)
		for i := 0; i < shardCount; i++ {
			memMu.Lock()
			name := fmt.Sprintf("%s_%d_%d", prefix, base, i)
			memMu.Unlock()
			s, err := openMemoryShard(name)
			if err != nil {
				return nil, err
			}
			if err := initSchema(s, ddl); err != nil {
				return nil, err
			}
			shards[i] = s
		}
		return NewGroup(shards), nil
	}

	return buildDatabase(openGroup, schemas)
}
