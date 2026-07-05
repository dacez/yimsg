package protocolgen

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	actionPrefix = "TYPE_ACTION_"
	notifyPrefix = "TYPE_NOTIFY_"
)

// Action 描述一个客户端到服务端的 action（入方向 Go / 出方向 TS）。
type Action struct {
	TypeID          int    `json:"type_id"`
	EnumName        string `json:"enum_name"`
	ActionName      string `json:"action_name"`
	GoMethod        string `json:"go_method"`
	TSFunction      string `json:"ts_function"`
	Auth            bool   `json:"auth"`
	Domain          string `json:"domain"`
	Desc            string `json:"desc"`
	RequestMessage  string `json:"request_message"`
	ResponseMessage string `json:"response_message"`
}

// Notification 描述一个服务端到客户端的通知（出方向 Go / 入方向 TS）。
type Notification struct {
	TypeID          int    `json:"type_id"`
	EnumName        string `json:"enum_name"`
	Name            string `json:"notification_name"`
	GoHelper        string `json:"go_helper"`
	TSHandlerMethod string `json:"ts_handler_method"`
	Desc            string `json:"desc"`
	MessageType     string `json:"message_type"`
}

// Manifest 是协议机械映射的中间产物，所有生成器和文档都以它为输入。
type Manifest struct {
	Actions       []Action       `json:"actions"`
	Notifications []Notification `json:"notifications"`
}

var (
	reKVAction = regexp.MustCompile(`action=(\S+)`)
	reKVNotify = regexp.MustCompile(`notification=(\S+)`)
	reKVAuth   = regexp.MustCompile(`auth=(\S+)`)
	reKVDomain = regexp.MustCompile(`domain=(\S+)`)
	reKVDesc   = regexp.MustCompile(`desc=(.*)$`)
)

// BuildManifest 从解析结果生成 manifest，并执行命名一致性校验；不一致直接报错。
func BuildManifest(p *Proto) (*Manifest, error) {
	m := &Manifest{}
	for _, ev := range p.TypeValues {
		switch {
		case ev.Name == "TYPE_INVALID":
			continue
		case strings.HasPrefix(ev.Name, actionPrefix):
			action, err := buildAction(p, ev)
			if err != nil {
				return nil, err
			}
			m.Actions = append(m.Actions, action)
		case strings.HasPrefix(ev.Name, notifyPrefix):
			notif, err := buildNotification(p, ev)
			if err != nil {
				return nil, err
			}
			m.Notifications = append(m.Notifications, notif)
		default:
			return nil, fmt.Errorf("Type 枚举项 %s 既不是 %s* 也不是 %s*", ev.Name, actionPrefix, notifyPrefix)
		}
	}
	if len(m.Actions) == 0 {
		return nil, fmt.Errorf("未解析到任何 action")
	}
	return m, nil
}

func buildAction(p *Proto, ev EnumValue) (Action, error) {
	base := strings.TrimPrefix(ev.Name, actionPrefix)
	pascal := pascalCase(base)
	snake := strings.ToLower(base)

	actionName := submatch(reKVAction, ev.Comment)
	if actionName == "" {
		return Action{}, fmt.Errorf("%s 缺少 action= 注释", ev.Name)
	}
	if actionName != snake {
		return Action{}, fmt.Errorf("%s 的 action=%q 与枚举名推导出的 %q 不一致", ev.Name, actionName, snake)
	}

	reqMsg := pascal + "Request"
	respMsg := pascal + "Response"
	if _, ok := p.Messages[reqMsg]; !ok {
		return Action{}, fmt.Errorf("%s 缺少请求消息 %s", ev.Name, reqMsg)
	}
	if _, ok := p.Messages[respMsg]; !ok {
		return Action{}, fmt.Errorf("%s 缺少响应消息 %s", ev.Name, respMsg)
	}

	authStr := submatch(reKVAuth, ev.Comment)
	if authStr != "true" && authStr != "false" {
		return Action{}, fmt.Errorf("%s 的 auth= 注释必须是 true 或 false，得到 %q", ev.Name, authStr)
	}

	return Action{
		TypeID:          ev.Number,
		EnumName:        ev.Name,
		ActionName:      actionName,
		GoMethod:        pascal,
		TSFunction:      camelCase(base),
		Auth:            authStr == "true",
		Domain:          submatch(reKVDomain, ev.Comment),
		Desc:            submatch(reKVDesc, ev.Comment),
		RequestMessage:  reqMsg,
		ResponseMessage: respMsg,
	}, nil
}

func buildNotification(p *Proto, ev EnumValue) (Notification, error) {
	base := strings.TrimPrefix(ev.Name, notifyPrefix)
	pascal := pascalCase(base)

	name := submatch(reKVNotify, ev.Comment)
	if name == "" {
		return Notification{}, fmt.Errorf("%s 缺少 notification= 注释", ev.Name)
	}
	normalized := strings.ToUpper(strings.ReplaceAll(name, ":", "_"))
	if normalized != base {
		return Notification{}, fmt.Errorf("%s 的 notification=%q 与枚举名推导出的 %q 不一致", ev.Name, name, strings.ToLower(base))
	}

	msgType := pascal + "Notification"
	if _, ok := p.Messages[msgType]; !ok {
		return Notification{}, fmt.Errorf("%s 缺少通知消息 %s", ev.Name, msgType)
	}

	return Notification{
		TypeID:          ev.Number,
		EnumName:        ev.Name,
		Name:            name,
		GoHelper:        "New" + pascal + "NotificationFrame",
		TSHandlerMethod: "on" + pascal,
		Desc:            submatch(reKVDesc, ev.Comment),
		MessageType:     msgType,
	}, nil
}

func submatch(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func pascalCase(upperSnake string) string {
	parts := strings.Split(strings.ToLower(upperSnake), "_")
	var b strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		b.WriteString(strings.ToUpper(part[:1]))
		b.WriteString(part[1:])
	}
	return b.String()
}

func camelCase(upperSnake string) string {
	pascal := pascalCase(upperSnake)
	if pascal == "" {
		return pascal
	}
	return strings.ToLower(pascal[:1]) + pascal[1:]
}
