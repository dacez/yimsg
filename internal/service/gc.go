package service

import (
	"log"
	"time"
	"yimsg/internal/auth"
	"yimsg/internal/dal"
	"yimsg/internal/shard"
)

const gcBatchSize int64 = 500

// gcTicker 按秒级配置创建 GC 定时器，非正值时回退到默认秒数。
func gcTicker(intervalSecs, defaultSecs int64) *time.Ticker {
	interval := time.Duration(intervalSecs) * time.Second
	if interval <= 0 {
		interval = time.Duration(defaultSecs) * time.Second
	}
	return time.NewTicker(interval)
}

// uidPurger 抽象按 UID 分片、无保留窗口的分页清理 Store（联系人/黑名单/静音）。
type uidPurger interface {
	ListPurgeable(limit, afterUID int64) ([]int64, error)
	Purge(uid int64) (int64, error)
}

// windowPurger 抽象按 UID 分片、带保留窗口（maxCount）的分页清理 Store（消息/会话）。
type windowPurger interface {
	ListPurgeable(retainSeqWindow, limit, afterUID int64) ([]int64, error)
	Purge(uid, retainSeqWindow int64) (int64, error)
}

// runUIDShardGC 周期性遍历所有 UID 分片，分页拉取可清理 UID 并逐个 Purge。
func runUIDShardGC(s *AppState, intervalSecs int64, label string, newStore func(*shard.DB) uidPurger) {
	runShardGroupGC(s.DB().UIDShards, intervalSecs, label, newStore)
}

// runShardGroupGC 周期性遍历指定分片组，分页拉取可清理路由键并逐个 Purge。
// uidPurger 的 (limit, afterKey) 游标形状对 uid / org_id 等 int64 路由键通用。
func runShardGroupGC(group *shard.Group, intervalSecs int64, label string, newStore func(*shard.DB) uidPurger) {
	ticker := gcTicker(intervalSecs, 300)
	defer ticker.Stop()

	for range ticker.C {
		total := int64(0)
		for _, sh := range group.AllShards() {
			store := newStore(sh)
			var afterUID int64
			for {
				uids, err := store.ListPurgeable(gcBatchSize, afterUID)
				if err != nil {
					log.Printf("%s gc list err: %v", label, err)
					break
				}
				if len(uids) == 0 {
					break
				}
				for _, uid := range uids {
					n, err := store.Purge(uid)
					if err != nil {
						log.Printf("%s gc uid=%d err: %v", label, uid, err)
						continue
					}
					total += n
				}
				afterUID = uids[len(uids)-1]
			}
		}
		if total > 0 {
			log.Printf("%s gc: purged %d entries", label, total)
		}
	}
}

// runUIDShardWindowGC 与 runUIDShardGC 类似，但清理需要保留窗口 maxCount（非正值回退 defaultMax）。
func runUIDShardWindowGC(s *AppState, intervalSecs, maxCount, defaultMax int64, label string, newStore func(*shard.DB) windowPurger) {
	if maxCount <= 0 {
		maxCount = defaultMax
	}
	ticker := gcTicker(intervalSecs, 300)
	defer ticker.Stop()

	for range ticker.C {
		total := int64(0)
		for _, sh := range s.DB().UIDShards.AllShards() {
			store := newStore(sh)
			var afterUID int64
			for {
				uids, err := store.ListPurgeable(maxCount, gcBatchSize, afterUID)
				if err != nil {
					log.Printf("%s gc list err: %v", label, err)
					break
				}
				if len(uids) == 0 {
					break
				}
				for _, uid := range uids {
					n, err := store.Purge(uid, maxCount)
					if err != nil {
						log.Printf("%s gc uid=%d err: %v", label, uid, err)
						continue
					}
					total += n
				}
				afterUID = uids[len(uids)-1]
			}
		}
		if total > 0 {
			log.Printf("%s gc: deleted %d entries", label, total)
		}
	}
}

// StartGC launches all GC goroutines in the background.
func StartGC(s *AppState) {
	go sessionGCLoop(s)
	go messageGCLoop(s)
	go conversationGCLoop(s)
	go contactGCLoop(s)
	go orgContactGCLoop(s)
	go blocklistGCLoop(s)
	go muteGCLoop(s)
	go orgGCLoop(s)
	go userGCLoop(s)
}

func sessionGCLoop(s *AppState) {
	ticker := gcTicker(s.Config().GC.SessionCleanupIntervalSecs, 60)
	defer ticker.Stop()

	for range ticker.C {
		now := auth.NowMs()
		total := int64(0)
		for _, sh := range s.DB().TokenShards.AllShards() {
			store := dal.NewSessionStore(sh)
			for {
				n, err := store.Purge(now, gcBatchSize)
				if err != nil {
					log.Printf("session gc err: %v", err)
					break
				}
				total += n
				if n < gcBatchSize {
					break
				}
			}
		}

		// Clean orphan user_session entries
		for _, sh := range s.DB().UIDShards.AllShards() {
			usStore := dal.NewUserSessionStore(sh)
			uids, _ := usStore.ListAll(gcBatchSize)
			for _, uid := range uids {
				tokens, _ := usStore.ListTokens(uid)
				for _, t := range tokens {
					ss := s.SessionStore(t.Token)
					sess, _ := ss.Get(t.Token)
					if sess == nil {
						_ = usStore.RemoveToken(uid, t.Token)
					}
				}
			}
		}

		if total > 0 {
			log.Printf("session gc: cleaned %d expired sessions", total)
		}
	}
}

func messageGCLoop(s *AppState) {
	runUIDShardWindowGC(s, s.Config().GC.MessageGCIntervalSecs, s.Config().GC.MessageMaxCount, 1000000, "message",
		func(sh *shard.DB) windowPurger { return dal.NewMessageStore(sh) })
}

func conversationGCLoop(s *AppState) {
	runUIDShardWindowGC(s, s.Config().GC.ConversationGCIntervalSecs, s.Config().GC.ConversationMaxCount, 100000, "conversation",
		func(sh *shard.DB) windowPurger { return dal.NewConversationStore(sh) })
}

func contactGCLoop(s *AppState) {
	runUIDShardGC(s, s.Config().GC.ContactGCIntervalSecs, "contact",
		func(sh *shard.DB) uidPurger { return dal.NewContactStore(sh) })
}

// orgContactGCLoop 兜底清理孤儿组织通讯录行：delete_org 已经在写路径同步清空
// 组织结构、异步扇出成员通讯录清理任务（见 internal/service/org.go 的
// submitOrgDeleted），但异步任务可能因为进程崩溃、载荷损坏等原因丢失；这里
// 周期性核对每条 ACTIVE 组织通讯录行对应的组织是否仍然存在，不存在则补墓碑
// （Delete，先软删），最终物理清理仍走既有 contactGCLoop 的 Purge，保证
// 组织与其成员通讯录行的最终一致。
func orgContactGCLoop(s *AppState) {
	ticker := gcTicker(s.Config().GC.ContactGCIntervalSecs, 300)
	defer ticker.Stop()

	for range ticker.C {
		total, err := s.sweepOrgContactGC()
		if err != nil {
			log.Printf("org contact gc err: %v", err)
		}
		if total > 0 {
			log.Printf("org contact gc: tombstoned %d orphan org contacts", total)
		}
	}
}

// sweepOrgContactGC 跑一整轮孤儿组织通讯录行清理，返回本轮补墓碑的行数。
// 拆成独立方法便于单测直接调用一次扫描，不必等待 ticker。
func (s *AppState) sweepOrgContactGC() (int64, error) {
	total := int64(0)
	for _, sh := range s.DB().UIDShards.AllShards() {
		cs := dal.NewContactStore(sh)
		var afterUID int64
		for {
			uids, err := cs.ListDistinctOrgContactUIDs(gcBatchSize, afterUID)
			if err != nil {
				return total, err
			}
			if len(uids) == 0 {
				break
			}
			for _, uid := range uids {
				orgIDs, err := cs.ListOrgIDs(uid)
				if err != nil {
					log.Printf("org contact gc list org ids uid=%d err: %v", uid, err)
					continue
				}
				for _, orgID := range orgIDs {
					info, err := s.OrgStore(orgID).GetOrgInfo(orgID)
					if err != nil {
						log.Printf("org contact gc get org info uid=%d org=%d err: %v", uid, orgID, err)
						continue
					}
					if info != nil {
						continue // 组织仍然存在
					}
					if _, _, err := cs.Delete(uid, 0, 0, orgID); err != nil {
						log.Printf("org contact gc tombstone uid=%d org=%d err: %v", uid, orgID, err)
						continue
					}
					total++
					notifyContactsUpdated(s, uid)
				}
			}
			afterUID = uids[len(uids)-1]
		}
	}
	return total, nil
}

func blocklistGCLoop(s *AppState) {
	runUIDShardGC(s, s.Config().GC.BlocklistGCIntervalSecs, "blocklist",
		func(sh *shard.DB) uidPurger { return dal.NewBlocklistStore(sh) })
}

func muteGCLoop(s *AppState) {
	runUIDShardGC(s, s.Config().GC.MutelistGCIntervalSecs, "mutelist",
		func(sh *shard.DB) uidPurger { return dal.NewMutelistStore(sh) })
}

// orgGCLoop 清理 tag 图 tombstone 并升 gc_safe_seq 水位线（org 分片组）。
func orgGCLoop(s *AppState) {
	runShardGroupGC(s.DB().OrgShards, s.Config().GC.OrgGCIntervalSecs, "org",
		func(sh *shard.DB) uidPurger { return dal.NewOrgStore(sh) })
}

func userGCLoop(s *AppState) {
	ticker := gcTicker(s.Config().GC.UserGCIntervalSecs, 3600)
	defer ticker.Stop()

	for range ticker.C {
		// Clean orphan user_lookup entries
		for _, sh := range s.DB().UsernameShards.AllShards() {
			lookupStore := dal.NewUserLookupStore(sh)
			lookups, err := lookupStore.ListAll(gcBatchSize)
			if err != nil {
				log.Printf("user gc lookup err: %v", err)
				continue
			}
			for username, uid := range lookups {
				userStore := s.UserStore(uid)
				user, _ := userStore.GetInfo(uid)
				if user == nil {
					_ = lookupStore.Delete(username)
				}
			}
		}
	}
}
