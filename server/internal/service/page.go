package service

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
)

// 展示通道统一分页：所有 get_* 列表使用不透明 keyset 游标，抗实时重排/增删漂移，
// 与 sync_* 的 seq 同步游标相互独立。游标对客户端不透明：服务端编码、客户端原样透传。
//
// 方向约定（与列表展示序无关，始终以"屏幕方向"为准）：
//   - PAGE_DIRECTION_FORWARD ：向列表尾/向下翻（追加）
//   - PAGE_DIRECTION_BACKWARD：向列表头/向上翻（前插）
// 续翻：向 FORWARD 用上一页的 end_cursor，向 BACKWARD 用上一页的 start_cursor。

const (
	cursorVersion = "1"
	cursorSep     = "\x1f"
)

// encodeCursor 把 keyset 字段编码为不透明游标：base64url("1" + sep + parts...)。
// 无字段时返回空串（表示该端到顶/到底）。
func encodeCursor(parts ...string) string {
	if len(parts) == 0 {
		return ""
	}
	raw := cursorVersion + cursorSep + strings.Join(parts, cursorSep)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeCursor 还原 encodeCursor 编码的字段；空串返回 nil 表示从起点开始。
func decodeCursor(cursor string) ([]string, error) {
	if cursor == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, fmt.Errorf("invalid cursor: %w", err)
	}
	parts := strings.Split(string(raw), cursorSep)
	if len(parts) < 1 || parts[0] != cursorVersion {
		return nil, fmt.Errorf("invalid cursor version")
	}
	return parts[1:], nil
}

func encodeSeqCursor(seq int64) string { return encodeCursor(strconv.FormatInt(seq, 10)) }

// decodeSeqCursor 还原单 seq 游标；空串返回 0。非法游标返回错误。
func decodeSeqCursor(cursor string) (int64, error) {
	parts, err := decodeCursor(cursor)
	if err != nil {
		return 0, err
	}
	if len(parts) == 0 {
		return 0, nil
	}
	seq, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid seq cursor: %w", err)
	}
	return seq, nil
}

// pageRequest 是从 PageQuery 解析出的规范化分页请求。
type pageRequest struct {
	cursor    string
	backward  bool
	around    string
	limit     int64
	hasCursor bool
}

func parsePageQuery(p *pb.PageQuery, maxLimit int64) pageRequest {
	return pageRequest{
		cursor:    p.GetCursor(),
		backward:  p.GetDirection() == pb.PageDirection_PAGE_DIRECTION_BACKWARD,
		around:    p.GetAround(),
		limit:     effectiveLimit(p.GetLimit(), maxLimit),
		hasCursor: p.GetCursor() != "",
	}
}

func reverseInPlace[T any](items []T) {
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
}

// fetchSeqPage 按统一展示通道语义读取一页 seq 游标列表，返回展示序结果与 PageInfo。
//
//   - descTop=true ：展示序 新→旧（会话/屏蔽/免打扰，列表顶部为最新）
//   - descTop=false：展示序 旧→新（消息，列表顶部为最旧、底部为最新）
//
// older(boundarySeq, limit)：取 seq<boundarySeq（boundarySeq=0 表示无下界）按 seq DESC 返回。
// newer(boundarySeq, limit)：取 seq>boundarySeq 按 seq ASC 返回。
func fetchSeqPage[T any](
	req pageRequest,
	descTop bool,
	older func(boundarySeq, limit int64) ([]T, error),
	newer func(boundarySeq, limit int64) ([]T, error),
	seqOf func(T) int64,
) ([]T, appmsg.PageInfo, error) {
	cursorSeq, err := decodeSeqCursor(req.cursor)
	if err != nil {
		return nil, appmsg.PageInfo{}, err
	}
	limit := req.limit

	// 决定本次抓取走 older 还是 newer：
	//   descTop ：FORWARD=向下=更旧(older)；BACKWARD=向上=更新(newer)
	//   ascTop  ：FORWARD=向下=更新(newer)；BACKWARD=向上=更旧(older)
	fetchOlder := descTop != req.backward
	var raw []T
	if fetchOlder {
		raw, err = older(cursorSeq, limit+1)
	} else {
		raw, err = newer(cursorSeq, limit+1)
	}
	if err != nil {
		return nil, appmsg.PageInfo{}, err
	}

	hasMoreTraveled := int64(len(raw)) > limit
	if hasMoreTraveled {
		raw = raw[:limit]
	}

	// older() 返回 DESC、newer() 返回 ASC；按展示序需要时反转。
	if fetchOlder != descTop {
		reverseInPlace(raw)
	}

	info := appmsg.PageInfo{Total: -1}
	if len(raw) > 0 {
		info.StartCursor = encodeSeqCursor(seqOf(raw[0]))
		info.EndCursor = encodeSeqCursor(seqOf(raw[len(raw)-1]))
	}
	// 行进方向的 has_more 精确计算；反方向由是否带游标推断（带游标说明来自该侧，仍有更多）。
	if req.backward {
		info.HasMoreBackward = hasMoreTraveled
		info.HasMoreForward = req.hasCursor
	} else {
		info.HasMoreForward = hasMoreTraveled
		info.HasMoreBackward = req.hasCursor
	}
	return raw, info, nil
}
