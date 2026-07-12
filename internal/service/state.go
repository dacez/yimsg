// Package service contains all business logic, organized by domain.
package service

import (
	"yimsg/internal/appmsg"
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/online"
	"yimsg/internal/plugin"
	"yimsg/internal/shard"
	"yimsg/internal/snowflake"
	"yimsg/internal/taskqueue"
)

// batchQueryShard groups IDs by shard and calls getBatch once per shard,
// collecting all results. Avoids N individual queries for cross-shard lookups.
//
// Usage:
//
//	items, err := batchQueryShard(s.DB().UIDShards, uids, func(db *shard.DB, batch []int64) ([]T, error) {
//	    return dal.NewXxxStore(db).GetBatch(batch)
//	})
func batchQueryShard[T any](sg *shard.Group, ids []int64, getBatch func(*shard.DB, []int64) ([]T, error)) ([]T, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	// Group IDs by shard index to issue one query per shard
	shardBatches := make(map[int][]int64)
	for _, id := range ids {
		idx := sg.ShardIndex(id)
		shardBatches[idx] = append(shardBatches[idx], id)
	}
	shards := sg.AllShards()
	var result []T
	for idx, batch := range shardBatches {
		items, err := getBatch(shards[idx], batch)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
	}
	return result, nil
}

// AppState holds all shared state for the application.
type AppState struct {
	db      *shard.Database
	idGen   *snowflake.Generator
	config  *config.Config
	online  *online.Registry
	Plugins *plugin.Registry

	// tasks 是通用异步任务队列：群消息 fanout、群系统消息等都在主流程中直接 Submit，
	// 由队列异步执行并（启用持久化时）在崩溃后重放。dispatch 不感知队列存在。
	tasks *taskqueue.Queue
}

// NewAppState creates a new AppState.
func NewAppState(db *shard.Database, cfg *config.Config, plugins *plugin.Registry) *AppState {
	return &AppState{
		db:      db,
		idGen:   snowflake.New(cfg.Server.MachineID),
		config:  cfg,
		online:  online.New(),
		Plugins: plugins,
	}
}

// UseTaskQueue 绑定异步任务队列并注册群消息 fanout / 群系统消息 handler。
// 须在任何 SendMessage / 群操作之前调用（main / seed / 测试装配阶段）。
func (s *AppState) UseTaskQueue(q *taskqueue.Queue) {
	s.tasks = q
	q.Register(taskKindGroupMessage, s.handleGroupMessageTask)
	q.Register(taskKindGroupSystem, s.handleGroupSystemTask)
	q.Register(taskKindOrgUpdated, s.handleOrgUpdatedTask)
	q.Register(taskKindOrgDeleted, s.handleOrgDeletedTask)
}

// ---- Store shortcuts: route key → dal.Store in one call ----

func (s *AppState) UserStore(uid int64) dal.UserStoreAPI {
	return dal.NewUserStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) ContactStore(uid int64) dal.ContactStoreAPI {
	return dal.NewContactStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) BlocklistStore(uid int64) dal.BlocklistStoreAPI {
	return dal.NewBlocklistStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) MessageStore(uid int64) dal.MessageStoreAPI {
	return dal.NewMessageStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) ConversationStore(uid int64) dal.ConversationStoreAPI {
	return dal.NewConversationStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) MutelistStore(uid int64) dal.MutelistStoreAPI {
	return dal.NewMutelistStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) UserSessionStore(uid int64) dal.UserSessionStoreAPI {
	return dal.NewUserSessionStore(s.db.UIDShards.RouteInt64(uid))
}
func (s *AppState) GroupStore(groupID int64) dal.GroupStoreAPI {
	return dal.NewGroupStore(s.db.GroupShards.RouteInt64(groupID))
}
func (s *AppState) OrgStore(orgID int64) dal.OrgStoreAPI {
	return dal.NewOrgStore(s.db.OrgShards.RouteInt64(orgID))
}
func (s *AppState) SessionStore(token string) dal.SessionStoreAPI {
	return dal.NewSessionStore(s.db.TokenShards.RouteStr(token))
}
func (s *AppState) UserLookupStore(username string) dal.UserLookupStoreAPI {
	return dal.NewUserLookupStore(s.db.UsernameShards.RouteStr(username))
}

// ---- Host 接口实现（供插件使用）----

func (s *AppState) DB() *shard.Database         { return s.db }
func (s *AppState) IDGen() *snowflake.Generator { return s.idGen }
func (s *AppState) Config() *config.Config      { return s.config }
func (s *AppState) Online() *online.Registry    { return s.online }

func (s *AppState) IsEitherWayBlocked(a, b int64) (bool, error) {
	return isEitherWayBlocked(s, a, b)
}

func clientConfig(s *AppState) *appmsg.ClientConfig {
	return &appmsg.ClientConfig{
		CacheTTLSeconds:     s.config.Client.CacheTTLSeconds,
		CacheMaxEntries:     s.config.Client.CacheMaxEntries,
		RecallWindowSeconds: s.config.Message.RecallWindowSeconds,
		BatchMaxLimit:       s.MaxBatchLimit(),
	}
}

func (s *AppState) MaxBatchLimit() int64 {
	limit := s.config.Client.BatchMaxLimit
	if limit <= 0 {
		return config.DefaultClientBatchMaxLimit
	}
	if limit > config.ClientBatchHardLimit {
		return config.ClientBatchHardLimit
	}
	return limit
}

// LookupProfiles batch-loads (nickname, avatar) for a list of UIDs.
// Uses batch queries grouped by shard instead of N individual queries.
func LookupProfiles(state *AppState, uids []int64) map[int64][2]string {
	// Deduplicate and filter zeros
	seen := make(map[int64]struct{}, len(uids))
	deduped := make([]int64, 0, len(uids))
	for _, uid := range uids {
		if uid == 0 {
			continue
		}
		if _, ok := seen[uid]; ok {
			continue
		}
		seen[uid] = struct{}{}
		deduped = append(deduped, uid)
	}

	result := make(map[int64][2]string, len(deduped))
	profiles, err := batchGetUserInfos(state, deduped)
	if err != nil {
		// Fill empty on error
		for _, uid := range deduped {
			result[uid] = [2]string{"", ""}
		}
		return result
	}

	for _, u := range profiles {
		result[u.UID] = [2]string{u.Nickname, u.Avatar}
	}
	// Fill empty for UIDs not found
	for _, uid := range deduped {
		if _, ok := result[uid]; !ok {
			result[uid] = [2]string{"", ""}
		}
	}
	return result
}
