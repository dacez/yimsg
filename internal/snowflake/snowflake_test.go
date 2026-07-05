package snowflake

import (
	"testing"
)

func TestUniqueness(t *testing.T) {
	g := New(1)
	seen := make(map[int64]bool)
	for i := 0; i < 10000; i++ {
		id := g.NextID()
		if seen[id] {
			t.Fatalf("duplicate id: %d", id)
		}
		seen[id] = true
	}
}

func TestMonotonic(t *testing.T) {
	g := New(1)
	prev := int64(0)
	for i := 0; i < 1000; i++ {
		id := g.NextID()
		if id <= prev {
			t.Fatalf("non-monotonic: %d <= %d", id, prev)
		}
		prev = id
	}
}

func TestPositive(t *testing.T) {
	g := New(0)
	id := g.NextID()
	if id <= 0 {
		t.Fatalf("expected positive, got %d", id)
	}
}
