package pipeline

import (
	"yimsg/agent/state"
	clistore "yimsg/cli/store"
	"yimsg/protocol/generated/go/pb"
)

// peerTarget 是一次分组要回复的目标：好友 uid 或群 group_id 二选一。
type peerTarget struct {
	isGroup bool
	uid     int64
	groupID int64
}

func (t peerTarget) toConversationTarget() *pb.ConversationTarget {
	if t.isGroup {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: t.groupID}}
	}
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: t.uid}}
}

// messageGroup 是一批 Pending 结果里属于同一个 peer 的消息，按 seq 升序。
type messageGroup struct {
	peerKey  string
	target   peerTarget
	messages []clistore.StoredMessage
	maxSeq   int64
}

// groupByPeer 把 Pending 返回的消息（已按 seq 升序）按 peer 首次出现的顺序分组，
// 组内保持原有的 seq 升序；对应 agent方案.md §4"批内分组"。Pending 已经排除了
// 自己发出的消息，因此单聊场景下 peer 就是 FromUID 本身，不需要额外推导。
func groupByPeer(msgs []clistore.StoredMessage) []messageGroup {
	order := make([]string, 0)
	byKey := make(map[string]*messageGroup)
	for _, m := range msgs {
		var key string
		var target peerTarget
		if m.GroupID != 0 {
			key = state.PeerKeyForGroup(m.GroupID)
			target = peerTarget{isGroup: true, groupID: m.GroupID}
		} else {
			key = state.PeerKeyForUser(m.FromUID)
			target = peerTarget{isGroup: false, uid: m.FromUID}
		}
		g, ok := byKey[key]
		if !ok {
			g = &messageGroup{peerKey: key, target: target}
			byKey[key] = g
			order = append(order, key)
		}
		g.messages = append(g.messages, m)
		if m.Seq > g.maxSeq {
			g.maxSeq = m.Seq
		}
	}
	out := make([]messageGroup, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out
}
