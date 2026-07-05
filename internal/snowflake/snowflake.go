// Package snowflake provides a thread-safe Snowflake ID generator.
//
// Layout: 41-bit timestamp (ms) | 10-bit machine | 12-bit sequence
// Epoch: 2023-11-14 00:00:00 UTC (1700000000000 ms)
package snowflake

import (
	"sync"
	"time"
)

const (
	epoch        = int64(1700000000000)
	machineBits  = 10
	sequenceBits = 12
	maxSequence  = (1 << sequenceBits) - 1
	maxMachine   = (1 << machineBits) - 1
)

type Generator struct {
	mu        sync.Mutex
	machineID int64
	sequence  int64
	lastTime  int64
}

func New(machineID int64) *Generator {
	return &Generator{machineID: machineID & int64(maxMachine)}
}

func (g *Generator) NextID() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now().UnixMilli() - epoch
	if now == g.lastTime {
		g.sequence = (g.sequence + 1) & maxSequence
		if g.sequence == 0 {
			// Spin until next millisecond
			for now <= g.lastTime {
				now = time.Now().UnixMilli() - epoch
			}
		}
	} else {
		g.sequence = 0
	}
	g.lastTime = now

	return (now << (machineBits + sequenceBits)) |
		(g.machineID << sequenceBits) |
		g.sequence
}
