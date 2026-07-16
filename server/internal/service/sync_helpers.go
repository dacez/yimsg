package service

import "yimsg/server/internal/appmsg"

type collectionResponse[T any] func(uint64, []T) *appmsg.Response

func notifyOnlineUser(s *AppState, uid int64, notif func() *appmsg.Notification) {
	if uid == 0 {
		return
	}
	s.Online().Notify(uid, notif())
}

func notifyOnlineUsers(s *AppState, notif func() *appmsg.Notification, uids ...int64) {
	for _, uid := range uids {
		notifyOnlineUser(s, uid, notif)
	}
}

// respondSyncPage 处理增量同步的一页：load 需多取 1 条（limit+1）用于探测 has_more；
// 截断到 limit 条后用 ok 构造响应，再按本批最大 seq 写入 cursor_seq、按是否截断写入 has_more
// （本批为空时 cursor_seq=0，客户端应保持原 last_seq）。
func respondSyncPage[T any](reqID uint64, limit int64, load func() ([]T, error), seqOf func(T) int64, ok collectionResponse[T]) *appmsg.Response {
	items, err := load()
	if err != nil {
		return appmsg.ErrInternal(reqID, err.Error())
	}
	hasMore := int64(len(items)) > limit
	if hasMore {
		items = items[:limit]
	}
	resp := ok(reqID, items)
	seqs := make([]int64, len(items))
	for i, item := range items {
		seqs[i] = seqOf(item)
	}
	setCursor(resp, seqs, true, hasMore)
	return resp
}
