// Package protocolgen 以 protocol/yimsg.proto 为唯一事实源，
// 解析协议并生成 Go / TypeScript 两端的机械映射代码与协议文档。
//
// 业务逻辑、SDK 公开接口、DataGateway、缓存、状态机、msg_id 生成等仍然手写，
// 本包只负责消灭协议机械映射的手写漂移。
package protocolgen

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Field 是 protobuf message 中的一个顶层字段（不含 oneof 内部字段）。
type Field struct {
	Name      string // wire 字段名，snake_case
	ProtoType string // proto 类型名，例如 int64 / Contact / ContactStatus
	Repeated  bool   // 是否为 repeated 列表
	Optional  bool   // 是否为 proto3 optional
	Label     string // 注释首词，required / optional，可能为空
	Desc      string // 注释剩余说明
}

// Message 是一个 protobuf message 定义及其顶层字段。
type Message struct {
	Name   string
	Fields []Field
}

// EnumValue 是枚举项及其行内注释。
type EnumValue struct {
	Name    string
	Number  int
	Comment string
}

// Proto 是解析后的协议模型。
type Proto struct {
	TypeValues []EnumValue         // Type 枚举的全部取值
	EnumNames  map[string]bool     // 所有枚举类型名，用于把枚举字段显示为 number
	Messages   map[string]*Message // 全部 message，按名称索引
}

var (
	reMessageOpen   = regexp.MustCompile(`^message\s+(\w+)\s*\{\s*$`)
	reMessageInline = regexp.MustCompile(`^message\s+(\w+)\s*\{(.*)\}\s*$`)
	reEnumOpen      = regexp.MustCompile(`^enum\s+(\w+)\s*\{\s*$`)
	reEnumValue     = regexp.MustCompile(`^(\w+)\s*=\s*(\d+)\s*;\s*(?://\s*(.*))?$`)
	reField         = regexp.MustCompile(`^(repeated\s+|optional\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+\s*;\s*(?://\s*(.*))?$`)
)

// ParseProtoFile 解析 yimsg.proto。
func ParseProtoFile(path string) (*Proto, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseProto(string(data))
}

func parseProto(src string) (*Proto, error) {
	p := &Proto{
		EnumNames: map[string]bool{},
		Messages:  map[string]*Message{},
	}

	scanner := bufio.NewScanner(strings.NewReader(src))
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var (
		inEnum     bool
		enumName   string
		inMessage  bool
		curMessage *Message
		braceDepth int // message 内部的额外嵌套深度（oneof 等）
	)

	for scanner.Scan() {
		raw := scanner.Text()
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		// 行内 message：message X { ... }
		if m := reMessageInline.FindStringSubmatch(line); m != nil && !inEnum && !inMessage {
			msg := &Message{Name: m[1]}
			parseInlineFields(msg, m[2])
			p.Messages[msg.Name] = msg
			continue
		}

		if m := reMessageOpen.FindStringSubmatch(line); m != nil && !inEnum && !inMessage {
			inMessage = true
			braceDepth = 0
			curMessage = &Message{Name: m[1]}
			p.Messages[curMessage.Name] = curMessage
			continue
		}

		if m := reEnumOpen.FindStringSubmatch(line); m != nil && !inEnum && !inMessage {
			inEnum = true
			enumName = m[1]
			p.EnumNames[enumName] = true
			continue
		}

		if inEnum {
			if line == "}" {
				inEnum = false
				enumName = ""
				continue
			}
			if m := reEnumValue.FindStringSubmatch(line); m != nil {
				num, _ := strconv.Atoi(m[2])
				ev := EnumValue{Name: m[1], Number: num, Comment: strings.TrimSpace(m[3])}
				if enumName == "Type" {
					p.TypeValues = append(p.TypeValues, ev)
				}
			}
			continue
		}

		if inMessage {
			// 处理 oneof / 嵌套块：进入时增加深度，退出时减少。
			if strings.HasSuffix(line, "{") {
				braceDepth++
				continue
			}
			if line == "}" {
				if braceDepth > 0 {
					braceDepth--
					continue
				}
				inMessage = false
				curMessage = nil
				continue
			}
			if braceDepth > 0 {
				// oneof 等内部字段不纳入顶层字段。
				continue
			}
			if f, ok := parseField(line); ok {
				curMessage.Fields = append(curMessage.Fields, f)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(p.TypeValues) == 0 {
		return nil, fmt.Errorf("未在 proto 中找到 Type 枚举")
	}
	return p, nil
}

func parseInlineFields(msg *Message, body string) {
	for _, part := range strings.Split(body, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if f, ok := parseField(part + ";"); ok {
			msg.Fields = append(msg.Fields, f)
		}
	}
}

func parseField(line string) (Field, bool) {
	m := reField.FindStringSubmatch(line)
	if m == nil {
		return Field{}, false
	}
	qualifier := strings.TrimSpace(m[1])
	f := Field{
		Name:      m[3],
		ProtoType: m[2],
		Repeated:  qualifier == "repeated",
		Optional:  qualifier == "optional",
	}
	comment := strings.TrimSpace(m[4])
	if comment != "" {
		fields := strings.SplitN(comment, " ", 2)
		switch fields[0] {
		case "required", "optional":
			f.Label = fields[0]
			if len(fields) > 1 {
				f.Desc = strings.TrimSpace(fields[1])
			}
		default:
			f.Desc = comment
		}
	}
	return f, true
}
