// Package taskqueue 提供一个通用的异步任务队列：业务在主流程中直接 Submit 一个
// (kind, payload)，队列负责调度执行已注册的 handler。可选地用一个独立 SQLite 文件
// 持久化未完成任务，从而在崩溃 / 重启后 Recover 重放，保证任务最终被执行。
//
// 它不感知任何业务语义：群消息 fanout、群系统消息等都注册为 handler，由 service 层提供。
// handler 必须幂等——重放或并发执行同一任务时不能产生错误副作用。
package taskqueue

import (
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Handler 处理某一类任务。返回 error 表示失败：持久化记录会保留，下次启动重放。
type Handler func(payload []byte) error

// mode 决定 Submit 后任务何时执行。
type mode int

const (
	// modeManual：缓冲任务，由调用方显式 RunPending 同步执行（测试默认）。
	modeManual mode = iota
	// modeSync：Submit 即同步执行（seed / 离线工具，确保返回前写入完成）。
	modeSync
	// modeAsync：后台 worker 异步执行（线上）。
	modeAsync
)

// item 是一条待执行任务。id 为持久化行号（0 表示未持久化）。
type item struct {
	id      int64
	kind    string
	payload []byte
}

// Queue 是通用异步任务队列。零值不可用，请通过 Open 创建。
type Queue struct {
	db       *sql.DB // nil 表示不持久化（测试 / seed）
	handlers map[string]Handler

	mu      sync.Mutex
	mode    mode
	pending []item // modeManual 缓冲

	ch   chan item
	wg   sync.WaitGroup
	open bool // ch 是否已开启（async）
}

// Open 创建队列。dataDir 为空表示不持久化（仅内存调度，供测试 / seed 使用）。
// 默认 modeManual，需要时再 SetSync / SetAsync。
func Open(dataDir string) (*Queue, error) {
	q := &Queue{handlers: make(map[string]Handler), mode: modeManual}
	if dataDir == "" {
		return q, nil
	}

	path := filepath.Join(dataDir, "task_queue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open task queue: %w", err)
	}
	db.SetMaxOpenConns(1)
	for _, stmt := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("task queue pragma: %w", err)
		}
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS task_queue (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		kind       TEXT    NOT NULL,
		payload    BLOB    NOT NULL,
		created_at INTEGER NOT NULL
	)`); err != nil {
		db.Close()
		return nil, fmt.Errorf("task queue schema: %w", err)
	}
	q.db = db
	return q, nil
}

// Register 注册某一类任务的 handler。须在 Recover / Submit 之前完成注册。
func (q *Queue) Register(kind string, h Handler) {
	q.handlers[kind] = h
}

// SetSync 切换为同步模式：Submit 立即执行 handler（供 seed / 离线工具）。
func (q *Queue) SetSync() {
	q.mu.Lock()
	q.mode = modeSync
	q.mu.Unlock()
}

// SetAsync 切换为异步模式并启动 workers。须在 Recover 之前调用，使重放任务进入 worker。
func (q *Queue) SetAsync(workers int) {
	if workers <= 0 {
		workers = 1
	}
	q.mu.Lock()
	q.mode = modeAsync
	q.ch = make(chan item, 1024)
	q.open = true
	q.mu.Unlock()
	for i := 0; i < workers; i++ {
		q.wg.Add(1)
		go func() {
			defer q.wg.Done()
			for it := range q.ch {
				q.run(it)
			}
		}()
	}
}

// Submit 持久化（若启用）并按当前模式调度任务。
func (q *Queue) Submit(kind string, payload []byte) error {
	id, err := q.persist(kind, payload)
	if err != nil {
		return err
	}
	q.dispatch(item{id: id, kind: kind, payload: payload})
	return nil
}

// Recover 加载持久化的未完成任务，按入队顺序重新调度（崩溃 / 重启恢复）。
// async 模式下进入 worker，sync 模式下立即执行，manual 模式下进入缓冲。
func (q *Queue) Recover() error {
	if q.db == nil {
		return nil
	}
	rows, err := q.db.Query(`SELECT id, kind, payload FROM task_queue ORDER BY id ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.kind, &it.payload); err != nil {
			return err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, it := range items {
		log.Printf("task queue replay id=%d kind=%s", it.id, it.kind)
		q.dispatch(it)
	}
	return nil
}

// RunPending 同步执行所有缓冲任务（modeManual，供测试驱动）。
func (q *Queue) RunPending() {
	q.mu.Lock()
	items := q.pending
	q.pending = nil
	q.mu.Unlock()
	for _, it := range items {
		q.run(it)
	}
}

// Close 关闭 worker 并释放持久化连接。
func (q *Queue) Close() error {
	q.mu.Lock()
	open := q.open
	q.open = false
	if open {
		close(q.ch)
	}
	q.mu.Unlock()
	if open {
		q.wg.Wait()
	}
	if q.db != nil {
		return q.db.Close()
	}
	return nil
}

func (q *Queue) dispatch(it item) {
	q.mu.Lock()
	switch q.mode {
	case modeManual:
		q.pending = append(q.pending, it)
		q.mu.Unlock()
	case modeAsync:
		q.mu.Unlock()
		q.ch <- it
	default: // modeSync
		q.mu.Unlock()
		q.run(it)
	}
}

// run 执行单个任务；成功后删除持久化记录，失败保留以待下次重放。
func (q *Queue) run(it item) {
	h := q.handlers[it.kind]
	if h == nil {
		log.Printf("task queue: no handler for kind=%s", it.kind)
		return
	}
	if err := h(it.payload); err != nil {
		log.Printf("task queue handler kind=%s err=%v", it.kind, err)
		return
	}
	q.remove(it.id)
}

func (q *Queue) persist(kind string, payload []byte) (int64, error) {
	if q.db == nil {
		return 0, nil
	}
	res, err := q.db.Exec(
		`INSERT INTO task_queue (kind, payload, created_at) VALUES (?, ?, ?)`,
		kind, payload, time.Now().UnixMilli(),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (q *Queue) remove(id int64) {
	if q.db == nil || id == 0 {
		return
	}
	if _, err := q.db.Exec(`DELETE FROM task_queue WHERE id = ?`, id); err != nil {
		log.Printf("task queue delete id=%d err=%v", id, err)
	}
}
