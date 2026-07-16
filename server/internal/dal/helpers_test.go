package dal

import (
	"database/sql"
	"strings"
	"testing"
)

// TestPlaceholders 验证生成的占位符数量正确。
// 注意：n=0 会触发越界切片（`[:-1]`），调用方必须自行保证 n >= 1，
// 这里通过表驱动验证 n>=1 的合法输入。
func TestPlaceholders(t *testing.T) {
	cases := []struct {
		n    int
		want string
	}{
		{1, "?"},
		{2, "?,?"},
		{3, "?,?,?"},
		{5, "?,?,?,?,?"},
	}
	for _, c := range cases {
		got := placeholders(c.n)
		if got != c.want {
			t.Errorf("placeholders(%d) = %q, want %q", c.n, got, c.want)
		}
		if strings.Count(got, "?") != c.n {
			t.Errorf("placeholders(%d) has %d ?, want %d", c.n, strings.Count(got, "?"), c.n)
		}
	}
}

// TestInt64sToAny 验证 int64 切片到 any 切片的转换。
func TestInt64sToAny(t *testing.T) {
	// 空切片
	got := int64sToAny(nil)
	if len(got) != 0 {
		t.Errorf("nil input: got len %d", len(got))
	}

	// 普通切片
	ids := []int64{1, 2, 3, -100, 9007199254740993}
	got = int64sToAny(ids)
	if len(got) != len(ids) {
		t.Fatalf("len = %d, want %d", len(got), len(ids))
	}
	for i, v := range ids {
		if gv, ok := got[i].(int64); !ok || gv != v {
			t.Errorf("got[%d] = %v (%T), want %d (int64)", i, got[i], got[i], v)
		}
	}
}

// TestScanInt64Rows 使用真实的 SQLite 内存库验证 scanInt64Rows。
func TestScanInt64Rows(t *testing.T) {
	db := setupDB(t)
	s := db.UIDShards.AllShards()[0].Writer

	// 创建临时表并插入若干行
	if _, err := s.Exec(`CREATE TEMP TABLE ids (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, v := range []int64{1, 2, 3, 100, -1} {
		if _, err := s.Exec("INSERT INTO ids(id) VALUES(?)", v); err != nil {
			t.Fatalf("insert %d: %v", v, err)
		}
	}

	rows, err := s.Query("SELECT id FROM ids ORDER BY id")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	got, err := scanInt64Rows(rows)
	if err != nil {
		t.Fatalf("scanInt64Rows: %v", err)
	}
	want := []int64{-1, 1, 2, 3, 100}
	if len(got) != len(want) {
		t.Fatalf("len got %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got[%d] = %d, want %d", i, got[i], want[i])
		}
	}

	// 空结果集：scanInt64Rows 应返回 nil 切片并无错。
	rows2, err := s.Query("SELECT id FROM ids WHERE id = 99999")
	if err != nil {
		t.Fatalf("query empty: %v", err)
	}
	defer rows2.Close()
	got2, err := scanInt64Rows(rows2)
	if err != nil {
		t.Fatalf("scanInt64Rows empty: %v", err)
	}
	if len(got2) != 0 {
		t.Errorf("empty scan: len = %d, want 0", len(got2))
	}
}

// TestIsNoRows 验证 isNoRows 对 sql.ErrNoRows 的识别。
func TestIsNoRows(t *testing.T) {
	if !isNoRows(sql.ErrNoRows) {
		t.Error("isNoRows(sql.ErrNoRows) should be true")
	}
	if isNoRows(nil) {
		t.Error("isNoRows(nil) should be false")
	}
	if isNoRows(sql.ErrConnDone) {
		t.Error("isNoRows(sql.ErrConnDone) should be false")
	}
}
