package pipeline

import (
	"fmt"

	"yimsg/protocol/generated/go/pb"
)

// extractText 把一条消息的 MessageBody 转换成喂给 DeepSeek 的纯文本表示。v1 只
// 理解文本/Markdown/引用/系统消息，其余类型（图片、文件、撤回、转发）给出占位
// 说明而不是尝试解析媒体内容，见 agent方案.md 第 11 节"工具生态"差距。
func extractText(body *pb.MessageBody) string {
	switch k := body.GetKind().(type) {
	case *pb.MessageBody_Text:
		return k.Text.GetText()
	case *pb.MessageBody_Markdown:
		return k.Markdown.GetMarkdown()
	case *pb.MessageBody_Quote:
		return fmt.Sprintf("(引用「%s」) %s", k.Quote.GetQuotePreview(), k.Quote.GetText().GetText())
	case *pb.MessageBody_System:
		return "[系统消息] " + k.System.GetText()
	case *pb.MessageBody_Image:
		return "[图片消息，agent 暂不支持解析图片内容]"
	case *pb.MessageBody_File:
		return fmt.Sprintf("[文件消息: %s，agent 暂不支持解析文件内容]", k.File.GetName())
	case *pb.MessageBody_Recall:
		return "[对方撤回了一条消息]"
	case *pb.MessageBody_Forward:
		return "[转发消息，agent 暂不支持解析转发内容]"
	default:
		return "[不支持的消息类型]"
	}
}
