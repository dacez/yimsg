package protocolgen

import (
	"encoding/json"
	"fmt"
	"strings"
)

// GenManifestJSON 生成稳定排序的 manifest JSON。
func GenManifestJSON(m *Manifest) ([]byte, error) {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// GenMarkdown 生成 docs/generated/协议接口表.md。
func GenMarkdown(p *Proto, m *Manifest) []byte {
	var b strings.Builder
	b.WriteString("# 协议接口表\n\n")
	b.WriteString("> 主要对照：`internal/protocol/yimsg.proto`、`internal/protocol/pb/yimsg.pb.go`、`frontend/src/sdk/generated/yimsg.ts`、`internal/ws/`、`frontend/src/sdk/generated/`、`docs/protocol/README.md`。\n")
	b.WriteString("> 最后复核：由 `go run ./tools/cmd/protocolgen` 自动生成，请勿手工编辑。\n")
	b.WriteString("> 触发更新：协议 proto、生成器、type、请求 / 响应字段、错误码或通知类型变化时重新运行 `go run ./tools/cmd/protocolgen`。\n")
	b.WriteString("> 入口关系：上级索引见 [`../README.md`](../README.md)；协议治理方案见 [`../protocol/README.md`](../protocol/README.md)；完整 SDK ↔ 服务端映射见 [`../接口总览.md`](../接口总览.md)。\n\n")

	b.WriteString("## 帧格式\n\n")
	b.WriteString("核心业务 WebSocket 帧使用 protobuf 定义 body。帧格式为 `magic:uint8('M') + codec:uint8(bitfield) + reserved:uint8(0) + checksum:uint8(CRC-8) + size:uint16 + request_id:uint64 + type:uint16 + body`，header 为 16 字节，`size` 最大是 `65519`；`codec` bit0 表示大小端，bit1-4 表示 version，bit5-7 保留并与后续 `reserved` 字节连续；`type=0` 是无效值；action enum 命名统一为 `TYPE_ACTION_*`，通知 enum 命名统一为 `TYPE_NOTIFY_*`；`request_id=0` 且 `type` 位于通知段表示服务端通知。\n\n")

	b.WriteString("## 生成边界\n\n")
	b.WriteString("- Go：action 入方向生成 `ActionService` 接口 + `DispatchActionFrame(svc, info, frame)`；notification 出方向生成 `NewXxxNotificationFrame` / `EncodeNotificationFrame`。\n")
	b.WriteString("- TS：action 出方向生成无状态函数（如 `login(transport, req)`）；notification 入方向生成 `NotificationHandler` 接口 + `dispatchNotificationFrame(handler, frame)`。\n")
	b.WriteString("- 业务逻辑（Go service）、SDK 公开接口、DataGateway、缓存、状态机、`msg_id` 生成仍然手写；fanout（异步任务队列）/ notify / DB 写入属于 service，不属于 dispatch。\n\n")

	// action 表。
	b.WriteString("## Action（客户端 → 服务端）\n\n")
	b.WriteString("| type | 领域 | action | 认证 | Go 方法 | TS 函数 | 请求类型 | 响应类型 | 说明 |\n")
	b.WriteString("|---|---|---|---|---|---|---|---|---|\n")
	for _, a := range m.Actions {
		auth := "否"
		if a.Auth {
			auth = "是"
		}
		b.WriteString(fmt.Sprintf("| `%d` | %s | `%s` | %s | `%s` | `%s` | `%s` | `%s` | %s |\n",
			a.TypeID, a.Domain, a.ActionName, auth, a.GoMethod, a.TSFunction, a.RequestMessage, a.ResponseMessage, a.Desc))
	}
	b.WriteString("\n")

	// notification 表。
	b.WriteString("## Notification（服务端 → 客户端）\n\n")
	b.WriteString("| type | notification | Go helper | TS handler | 消息类型 | 说明 |\n")
	b.WriteString("|---|---|---|---|---|---|\n")
	for _, n := range m.Notifications {
		b.WriteString(fmt.Sprintf("| `%d` | `%s` | `%s` | `%s` | `%s` | %s |\n",
			n.TypeID, n.Name, n.GoHelper, n.TSHandlerMethod, n.MessageType, n.Desc))
	}
	b.WriteString("\n")

	// 每个 action 的字段明细。
	b.WriteString("## Action 字段明细\n\n")
	for _, a := range m.Actions {
		b.WriteString(fmt.Sprintf("### `%s`\n\n", a.ActionName))
		b.WriteString(fmt.Sprintf("- 请求：`%s`\n", a.RequestMessage))
		writeFields(&b, p, a.RequestMessage)
		b.WriteString(fmt.Sprintf("- 响应：`%s`\n", a.ResponseMessage))
		writeFields(&b, p, a.ResponseMessage)
		b.WriteString("\n")
	}
	return []byte(b.String())
}

func writeFields(b *strings.Builder, p *Proto, msgName string) {
	msg := p.Messages[msgName]
	if msg == nil {
		b.WriteString("  - 无业务字段。\n")
		return
	}
	wrote := false
	for _, f := range msg.Fields {
		if f.Name == "base" {
			// base 是通用响应状态信封，不在业务字段中重复列出。
			continue
		}
		label := fieldLabelCN(f.Label)
		display := fieldTypeDisplay(p, f)
		line := fmt.Sprintf("  - `%s`（`%s`，%s）", f.Name, display, label)
		if f.Desc != "" {
			line += "：" + f.Desc
		}
		b.WriteString(line + "\n")
		wrote = true
	}
	if !wrote {
		b.WriteString("  - 无业务字段。\n")
	}
}

func fieldLabelCN(label string) string {
	switch label {
	case "required":
		return "必填"
	case "optional":
		return "可选"
	default:
		return "可选"
	}
}

func fieldTypeDisplay(p *Proto, f Field) string {
	base := scalarDisplay(p, f.ProtoType)
	if f.Repeated {
		return base + "[]"
	}
	return base
}

func scalarDisplay(p *Proto, t string) string {
	switch t {
	case "int64", "int32", "uint64", "uint32", "sint64", "sint32", "fixed64", "fixed32", "sfixed64", "sfixed32":
		return "number"
	case "bool":
		return "boolean"
	case "string":
		return "string"
	case "bytes":
		return "Uint8Array"
	default:
		if p.EnumNames[t] {
			return "number"
		}
		return t
	}
}
