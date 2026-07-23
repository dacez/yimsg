// Package state 持久化 yimsg-agent 每个账号自己的处理进度游标与按对端分桶的
// 记忆，与 cli/store 的同步镜像是两套独立状态（见 agent/docs/agent方案.md 第 3
// 节）。整个包只服务单个账号，不同账号必须使用不同的 Store 实例/文件路径。
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// PeerMemory 是一个对端（好友或群）的滚动记忆摘要。
type PeerMemory struct {
	Summary   string `json:"summary"`
	UpdatedAt int64  `json:"updated_at"` // Unix 毫秒
	Turns     int    `json:"turns"`
}

// Memory 是账号内按 peer 分桶的记忆集合。
type Memory struct {
	Peers map[string]PeerMemory `json:"peers"`
}

// accountState 是落盘的 JSON 顶层结构，对应 agent_state.json。
type accountState struct {
	ProcessedSeq int64  `json:"processed_seq"`
	Memory       Memory `json:"memory"`
}

// PeerKeyForUser 返回好友对端的 peer key。
func PeerKeyForUser(uid int64) string {
	return fmt.Sprintf("u:%d", uid)
}

// PeerKeyForGroup 返回群对端的 peer key。
func PeerKeyForGroup(groupID int64) string {
	return fmt.Sprintf("g:%d", groupID)
}

// PeerUpdate 是一次 Commit 里对某个 peer 记忆的更新。
type PeerUpdate struct {
	Key     string
	Summary string
}

// Store 是单个账号的 agent_state.json 读写句柄，并发安全。
type Store struct {
	path        string
	maxCharsPer int
	maxPeers    int
	// clock 供测试注入确定性时间，默认 time.Now。
	clock func() time.Time

	mu    sync.Mutex
	state accountState
}

// Open 加载（或初始化）path 处的 agent_state.json。maxCharsPerPeer/maxPeers 对应
// agent方案.md §5.3 的硬性上限。
func Open(path string, maxCharsPerPeer, maxPeers int) (*Store, error) {
	s := &Store{
		path:        path,
		maxCharsPer: maxCharsPerPeer,
		maxPeers:    maxPeers,
		clock:       time.Now,
		state:       accountState{Memory: Memory{Peers: make(map[string]PeerMemory)}},
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("读取 agent_state.json 失败: %w", err)
	}
	var loaded accountState
	if err := json.Unmarshal(data, &loaded); err != nil {
		return nil, fmt.Errorf("解析 agent_state.json 失败: %w", err)
	}
	if loaded.Memory.Peers == nil {
		loaded.Memory.Peers = make(map[string]PeerMemory)
	}
	s.state = loaded
	return s, nil
}

// ProcessedSeq 返回当前已处理进度游标。
func (s *Store) ProcessedSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.ProcessedSeq
}

// PeerMemory 返回某个 peer 现有的记忆（未记录过则返回零值）。
func (s *Store) PeerMemory(key string) PeerMemory {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Memory.Peers[key]
}

// Commit 原子地推进处理进度游标并写回 peer 记忆更新，然后落盘。newSeq 必须
// 单调不小于当前游标才会生效（防止乱序调用把游标往回拨）；updates 里的每一项
// 都会追加/覆盖对应 peer 的记忆摘要（超过 maxCharsPerPeer 硬截断），随后按
// updated_at 淘汰超出 maxPeers 的最旧 peer。
func (s *Store) Commit(newSeq int64, updates []PeerUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if newSeq > s.state.ProcessedSeq {
		s.state.ProcessedSeq = newSeq
	}

	now := s.clock().UnixMilli()
	for _, u := range updates {
		summary := u.Summary
		if s.maxCharsPer > 0 && len(summary) > s.maxCharsPer {
			summary = summary[:s.maxCharsPer]
		}
		existing := s.state.Memory.Peers[u.Key]
		s.state.Memory.Peers[u.Key] = PeerMemory{
			Summary:   summary,
			UpdatedAt: now,
			Turns:     existing.Turns + 1,
		}
	}

	s.evictLocked()
	return s.persistLocked()
}

// evictLocked 按 updated_at 升序淘汰超出 maxPeers 的最旧条目，调用方需持锁。
func (s *Store) evictLocked() {
	if s.maxPeers <= 0 || len(s.state.Memory.Peers) <= s.maxPeers {
		return
	}
	type kv struct {
		key       string
		updatedAt int64
	}
	entries := make([]kv, 0, len(s.state.Memory.Peers))
	for k, v := range s.state.Memory.Peers {
		entries = append(entries, kv{k, v.UpdatedAt})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].updatedAt < entries[j].updatedAt })

	excess := len(entries) - s.maxPeers
	for i := 0; i < excess; i++ {
		delete(s.state.Memory.Peers, entries[i].key)
	}
}

// persistLocked 原子写入（临时文件 + rename），调用方需持锁。
func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return fmt.Errorf("编码 agent_state.json 失败: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("替换 agent_state.json 失败: %w", err)
	}
	return nil
}

// PeerCount 返回当前跟踪的 peer 数量，主要供测试使用。
func (s *Store) PeerCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.state.Memory.Peers)
}
