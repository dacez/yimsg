package main

import (
	"encoding/json"
	"fmt"
	"os"

	"yimsg/cli/store"
	"yimsg/protocol/generated/go/pb"
)

// emitOK 把成功结果编码为 JSON 打印到 stdout；AI 调用方按 exit code 判定成败，
// 成功时 stdout 恒为合法 JSON 且顶层带 "ok": true。
func emitOK(fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["ok"] = true
	printJSON(fields)
}

// emitFail 把失败原因编码为 JSON 打印到 stdout 并以退出码 1 结束进程。
func emitFail(err error) {
	printJSON(map[string]any{"ok": false, "error": err.Error()})
	os.Exit(1)
}

func printJSON(v any) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal output: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(data))
}

// bodyToJSON 把结构化 MessageBody 展开为便于 AI 阅读的通用 map，字段随 kind 变化。
func bodyToJSON(b *pb.MessageBody) map[string]any {
	switch k := b.GetKind().(type) {
	case *pb.MessageBody_Text:
		return map[string]any{"kind": "text", "text": k.Text.GetText()}
	case *pb.MessageBody_Markdown:
		return map[string]any{"kind": "markdown", "markdown": k.Markdown.GetMarkdown()}
	case *pb.MessageBody_Image:
		return map[string]any{
			"kind": "image", "media_id": k.Image.GetMediaId(), "caption": k.Image.GetCaption(),
			"width": k.Image.GetWidth(), "height": k.Image.GetHeight(),
			"mime": k.Image.GetMime(), "size": k.Image.GetSize(),
		}
	case *pb.MessageBody_File:
		return map[string]any{
			"kind": "file", "media_id": k.File.GetMediaId(), "name": k.File.GetName(),
			"mime": k.File.GetMime(), "size": k.File.GetSize(),
		}
	case *pb.MessageBody_System:
		return map[string]any{"kind": "system", "text": k.System.GetText()}
	case *pb.MessageBody_Recall:
		return map[string]any{
			"kind": "recall", "msg_id": k.Recall.GetMsgId(),
			"operator_uid": k.Recall.GetOperatorUid(), "text": k.Recall.GetText(),
		}
	case *pb.MessageBody_Quote:
		return map[string]any{
			"kind": "quote", "quote_msg_id": k.Quote.GetQuoteMsgId(),
			"quote_preview": k.Quote.GetQuotePreview(), "text": k.Quote.GetText().GetText(),
		}
	case *pb.MessageBody_Forward:
		return map[string]any{"kind": "forward", "msg_ids": k.Forward.GetMsgIds(), "title": k.Forward.GetTitle()}
	default:
		return map[string]any{"kind": "unknown"}
	}
}

// storedMessageJSON 把本地库读出的一条消息展开为 JSON 友好结构。
func storedMessageJSON(m store.StoredMessage) map[string]any {
	out := map[string]any{
		"seq":       m.Seq,
		"msg_id":    m.MsgID,
		"from_uid":  m.FromUID,
		"send_time": m.SendTime,
		"body":      bodyToJSON(m.Body),
	}
	if m.GroupID > 0 {
		out["group_id"] = m.GroupID
	} else {
		out["to_uid"] = m.ToUID
	}
	return out
}

func storedMessagesJSON(msgs []store.StoredMessage) []map[string]any {
	out := make([]map[string]any, len(msgs))
	for i, m := range msgs {
		out[i] = storedMessageJSON(m)
	}
	return out
}
