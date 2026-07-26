package service

import (
	"errors"
	"strings"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/dal"

	"google.golang.org/protobuf/proto"
)

const (
	maxTextRunes         = 4096
	maxMarkdownBytes     = 20000
	maxForwardItemsCount = 20
	maxMentionedUIDs     = 100
)

// msgTypeForBody 返回 body.kind 对应的 MessageType（int8）；第二返回值表示 oneof 是否已设置。
func msgTypeForBody(body *pb.MessageBody) (int8, bool) {
	if body == nil {
		return 0, false
	}
	switch body.GetKind().(type) {
	case *pb.MessageBody_Text:
		return dal.MsgText, true
	case *pb.MessageBody_Image:
		return dal.MsgImage, true
	case *pb.MessageBody_System:
		return dal.MsgSystem, true
	case *pb.MessageBody_File:
		return dal.MsgFile, true
	case *pb.MessageBody_Recall:
		return dal.MsgRecall, true
	case *pb.MessageBody_Quote:
		return dal.MsgQuote, true
	case *pb.MessageBody_Forward:
		return dal.MsgForward, true
	case *pb.MessageBody_Markdown:
		return dal.MsgMarkdown, true
	case *pb.MessageBody_Mention:
		return dal.MsgMention, true
	default:
		return 0, false
	}
}

// validateSendBody 校验 send_message 的 msg_type 与 body.kind 一致性及各类型业务约束。
// RECALL 不走这里，由撤回校验路径单独处理。
func validateSendBody(msgType int8, body *pb.MessageBody) error {
	kindType, ok := msgTypeForBody(body)
	if !ok {
		return errors.New("body_kind_required")
	}
	if kindType != msgType {
		return errors.New("msg_type_body_kind_mismatch")
	}
	switch b := body.GetKind().(type) {
	case *pb.MessageBody_Text:
		if b.Text.GetText() == "" {
			return errors.New("text_required")
		}
		if len([]rune(b.Text.GetText())) > maxTextRunes {
			return errors.New("text_too_long")
		}
	case *pb.MessageBody_Markdown:
		if b.Markdown.GetMarkdown() == "" {
			return errors.New("markdown_required")
		}
		if len(b.Markdown.GetMarkdown()) > maxMarkdownBytes {
			return errors.New("markdown_too_long")
		}
	case *pb.MessageBody_Image:
		if b.Image.GetMediaId() == 0 {
			return errors.New("image_media_id_required")
		}
	case *pb.MessageBody_File:
		if b.File.GetMediaId() == 0 {
			return errors.New("file_media_id_required")
		}
		if b.File.GetName() == "" {
			return errors.New("file_name_required")
		}
	case *pb.MessageBody_Quote:
		if b.Quote.GetQuoteMsgId() == "" {
			return errors.New("quote_msg_id_required")
		}
		if b.Quote.GetText().GetText() == "" {
			return errors.New("quote_text_required")
		}
	case *pb.MessageBody_Forward:
		if len(b.Forward.GetMsgIds()) == 0 {
			return errors.New("forward_msg_ids_required")
		}
		if len(b.Forward.GetMsgIds()) > maxForwardItemsCount {
			return errors.New("forward_items_limit_exceeded")
		}
	case *pb.MessageBody_System:
		if b.System.GetText() == "" {
			return errors.New("system_text_required")
		}
	case *pb.MessageBody_Mention:
		if b.Mention.GetText() == "" {
			return errors.New("mention_text_required")
		}
		if len([]rune(b.Mention.GetText())) > maxTextRunes {
			return errors.New("text_too_long")
		}
		if !b.Mention.GetMentionAll() && len(b.Mention.GetMentionedUids()) == 0 {
			return errors.New("mention_target_required")
		}
		if len(b.Mention.GetMentionedUids()) > maxMentionedUIDs {
			return errors.New("mention_uids_limit_exceeded")
		}
	}
	return nil
}

// messageSearchText 生成消息搜索投影，后端与前端本地持久层规则保持一致。
// search_text 是投影，不作为消息真实内容来源。
func messageSearchText(body *pb.MessageBody) string {
	if body == nil {
		return ""
	}
	switch b := body.GetKind().(type) {
	case *pb.MessageBody_Text:
		return b.Text.GetText()
	case *pb.MessageBody_Markdown:
		return b.Markdown.GetMarkdown()
	case *pb.MessageBody_Quote:
		return strings.TrimSpace(b.Quote.GetQuotePreview() + " " + b.Quote.GetText().GetText())
	case *pb.MessageBody_File:
		return b.File.GetName()
	case *pb.MessageBody_Image:
		return b.Image.GetCaption()
	case *pb.MessageBody_System:
		return b.System.GetText()
	case *pb.MessageBody_Forward:
		return b.Forward.GetTitle()
	case *pb.MessageBody_Mention:
		return b.Mention.GetText()
	case *pb.MessageBody_Recall:
		return ""
	default:
		return ""
	}
}

// encodeBodyWithSearch 把 MessageBody 编码为存储 body bytes 并算出 search_text 投影。
func encodeBodyWithSearch(body *pb.MessageBody) ([]byte, string, error) {
	raw, err := proto.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	if len(raw) == 0 {
		return nil, "", errors.New("empty_body")
	}
	return raw, messageSearchText(body), nil
}

func systemBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_System{System: &pb.SystemBody{Text: text}}}
}

func recallBody(targetMsgID string, operatorUID, recallTime int64, text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Recall{Recall: &pb.RecallBody{
		MsgId:       targetMsgID,
		OperatorUid: operatorUID,
		RecallTime:  recallTime,
		Text:        text,
	}}}
}

// decodeRecall 解码消息 body 中的 RecallBody，非撤回消息返回 nil。
func decodeRecall(msg dal.Message) *pb.RecallBody {
	if msg.MsgType != dal.MsgRecall || len(msg.Body) == 0 {
		return nil
	}
	var body pb.MessageBody
	if err := proto.Unmarshal(msg.Body, &body); err != nil {
		return nil
	}
	return body.GetRecall()
}
