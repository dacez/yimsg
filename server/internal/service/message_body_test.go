package service

import (
	"strings"
	"testing"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/msgid"

	"google.golang.org/protobuf/proto"
)

func textMsgBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}}
}

func TestValidateSendBody_OK(t *testing.T) {
	cases := []struct {
		name    string
		msgType int8
		body    *pb.MessageBody
	}{
		{"text", dal.MsgText, textMsgBody("hi")},
		{"markdown", dal.MsgMarkdown, &pb.MessageBody{Kind: &pb.MessageBody_Markdown{Markdown: &pb.MarkdownBody{Markdown: "# h"}}}},
		{"image", dal.MsgImage, &pb.MessageBody{Kind: &pb.MessageBody_Image{Image: &pb.ImageBody{MediaId: 9, Caption: "cap"}}}},
		{"file", dal.MsgFile, &pb.MessageBody{Kind: &pb.MessageBody_File{File: &pb.FileBody{MediaId: 9, Name: "a.pdf"}}}},
		{"quote", dal.MsgQuote, &pb.MessageBody{Kind: &pb.MessageBody_Quote{Quote: &pb.QuoteBody{QuoteMsgId: msgid.Generate(), QuotePreview: "p", Text: &pb.TextBody{Text: "re"}}}}},
		{"forward", dal.MsgForward, &pb.MessageBody{Kind: &pb.MessageBody_Forward{Forward: &pb.ForwardBody{MsgIds: []string{msgid.Generate(), msgid.Generate()}, Title: "t"}}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := validateSendBody(c.msgType, c.body); err != nil {
				t.Fatalf("validateSendBody(%s) = %v, want nil", c.name, err)
			}
		})
	}
}

func TestValidateSendBody_TypeKindMismatch(t *testing.T) {
	err := validateSendBody(dal.MsgImage, textMsgBody("hi"))
	if err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("expected mismatch error, got %v", err)
	}
}

func TestValidateSendBody_EmptyBody(t *testing.T) {
	if err := validateSendBody(dal.MsgText, nil); err == nil {
		t.Fatal("nil body should be rejected")
	}
	if err := validateSendBody(dal.MsgText, &pb.MessageBody{}); err == nil {
		t.Fatal("empty oneof should be rejected")
	}
}

func TestValidateSendBody_ForwardLimit(t *testing.T) {
	ids := make([]string, 0, maxForwardItemsCount+1)
	for i := 0; i <= maxForwardItemsCount; i++ {
		ids = append(ids, msgid.Generate())
	}
	body := &pb.MessageBody{Kind: &pb.MessageBody_Forward{Forward: &pb.ForwardBody{MsgIds: ids, Title: "t"}}}
	if err := validateSendBody(dal.MsgForward, body); err == nil {
		t.Fatal("forward over limit should be rejected")
	}
}

func TestMessageSearchText(t *testing.T) {
	cases := []struct {
		name string
		body *pb.MessageBody
		want string
	}{
		{"text", textMsgBody("hello world"), "hello world"},
		{"markdown", &pb.MessageBody{Kind: &pb.MessageBody_Markdown{Markdown: &pb.MarkdownBody{Markdown: "# title"}}}, "# title"},
		{"quote", &pb.MessageBody{Kind: &pb.MessageBody_Quote{Quote: &pb.QuoteBody{QuotePreview: "orig", Text: &pb.TextBody{Text: "reply"}}}}, "orig reply"},
		{"file", &pb.MessageBody{Kind: &pb.MessageBody_File{File: &pb.FileBody{Name: "report.pdf"}}}, "report.pdf"},
		{"image_caption", &pb.MessageBody{Kind: &pb.MessageBody_Image{Image: &pb.ImageBody{Caption: "sunset"}}}, "sunset"},
		{"image_empty", &pb.MessageBody{Kind: &pb.MessageBody_Image{Image: &pb.ImageBody{}}}, ""},
		{"forward", &pb.MessageBody{Kind: &pb.MessageBody_Forward{Forward: &pb.ForwardBody{Title: "chat log"}}}, "chat log"},
		{"recall", recallBody(msgid.Generate(), 2, 3, "你撤回了一条消息"), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := messageSearchText(c.body); got != c.want {
				t.Fatalf("messageSearchText(%s) = %q, want %q", c.name, got, c.want)
			}
		})
	}
}

func TestEncodeBodyWithSearchRoundTrip(t *testing.T) {
	raw, search, err := encodeBodyWithSearch(textMsgBody("hi there"))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("body bytes should not be empty")
	}
	if search != "hi there" {
		t.Fatalf("search = %q", search)
	}
	var decoded pb.MessageBody
	if err := proto.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.GetText().GetText() != "hi there" {
		t.Fatalf("decoded text = %q", decoded.GetText().GetText())
	}
}
