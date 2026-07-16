package taskqueue

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	_ "modernc.org/sqlite"
)

// TestSyncMode 验证同步模式下 Submit 立即执行 handler。
func TestSyncMode(t *testing.T) {
	q, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()

	var got string
	q.Register("greet", func(p []byte) error { got = string(p); return nil })
	q.SetSync()

	if err := q.Submit("greet", []byte("hi")); err != nil {
		t.Fatal(err)
	}
	if got != "hi" {
		t.Fatalf("sync handler not run, got %q", got)
	}
}

// TestManualMode 验证 manual 模式缓冲任务、RunPending 后才执行。
func TestManualMode(t *testing.T) {
	q, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()

	var n int
	q.Register("inc", func(p []byte) error { n++; return nil })

	_ = q.Submit("inc", nil)
	_ = q.Submit("inc", nil)
	if n != 0 {
		t.Fatalf("manual mode should buffer, got n=%d", n)
	}
	q.RunPending()
	if n != 2 {
		t.Fatalf("RunPending should run 2 tasks, got n=%d", n)
	}
}

// TestAsyncMode 验证异步模式下 worker 执行任务。
func TestAsyncMode(t *testing.T) {
	q, err := Open("")
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var n int64
	wg.Add(3)
	q.Register("work", func(p []byte) error { atomic.AddInt64(&n, 1); wg.Done(); return nil })
	q.SetAsync(2)

	for i := 0; i < 3; i++ {
		if err := q.Submit("work", nil); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	q.Close()
	if atomic.LoadInt64(&n) != 3 {
		t.Fatalf("async should run 3 tasks, got n=%d", n)
	}
}

// TestPersistAndRecover 验证失败任务保留、成功任务删除，重启可重放未完成任务。
func TestPersistAndRecover(t *testing.T) {
	dir := t.TempDir()

	q, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// handler 返回错误：任务执行失败，持久化记录保留。
	q.Register("flaky", func(p []byte) error { return errors.New("boom") })
	if err := q.Submit("flaky", []byte("payload")); err != nil {
		t.Fatal(err)
	}
	q.RunPending() // 执行失败，行保留
	q.Close()

	// 新进程：注册一个成功 handler，Recover 重放并消费。
	q2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer q2.Close()
	var replayed string
	q2.Register("flaky", func(p []byte) error { replayed = string(p); return nil })
	if err := q2.Recover(); err != nil {
		t.Fatal(err)
	}
	q2.RunPending()
	if replayed != "payload" {
		t.Fatalf("recover should replay pending task, got %q", replayed)
	}

	// 再次 Recover 应为空（成功后已删除）。
	q2.Recover()
	q2.RunPending()
}
