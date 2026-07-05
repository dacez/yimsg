package protocolgen

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// 相对仓库根目录的生成物路径。protoc 直接产出的 pb.go / yimsg.ts 不在此列。
const (
	ProtoRelPath = "internal/protocol/yimsg.proto"

	outGoActionService = "internal/ws/action_service_gen.go"
	outGoDispatch      = "internal/ws/action_dispatch_gen.go"
	outGoNotification  = "internal/ws/notification_frame_gen.go"
	outTSActions       = "frontend/src/sdk/generated/actions.gen.ts"
	outTSNotifications = "frontend/src/sdk/generated/notifications.gen.ts"
	outMarkdown        = "docs/generated/协议接口表.md"
	outManifestJSON    = "docs/generated/protocol_manifest.json"
)

// BuildOutputs 解析 proto、构造 manifest 并生成全部非 protoc 生成物（路径 -> 内容）。
func BuildOutputs(root string) (map[string][]byte, error) {
	p, err := ParseProtoFile(filepath.Join(root, ProtoRelPath))
	if err != nil {
		return nil, err
	}
	m, err := BuildManifest(p)
	if err != nil {
		return nil, err
	}

	goService, err := GenGoActionService(m)
	if err != nil {
		return nil, fmt.Errorf("生成 %s 失败: %w", outGoActionService, err)
	}
	goDispatch, err := GenGoDispatch(m)
	if err != nil {
		return nil, fmt.Errorf("生成 %s 失败: %w", outGoDispatch, err)
	}
	goNotif, err := GenGoNotification(m)
	if err != nil {
		return nil, fmt.Errorf("生成 %s 失败: %w", outGoNotification, err)
	}
	manifestJSON, err := GenManifestJSON(m)
	if err != nil {
		return nil, err
	}

	return map[string][]byte{
		outGoActionService: goService,
		outGoDispatch:      goDispatch,
		outGoNotification:  goNotif,
		outTSActions:       GenTSActions(m),
		outTSNotifications: GenTSNotifications(m),
		outMarkdown:        GenMarkdown(p, m),
		outManifestJSON:    manifestJSON,
	}, nil
}

// WriteOutputs 把生成物写入磁盘。
func WriteOutputs(root string) error {
	outputs, err := BuildOutputs(root)
	if err != nil {
		return err
	}
	for rel, content := range outputs {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(abs, content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// CheckOutputs 比较生成物与磁盘内容，返回不一致的文件列表。
func CheckOutputs(root string) ([]string, error) {
	outputs, err := BuildOutputs(root)
	if err != nil {
		return nil, err
	}
	var diffs []string
	for rel, content := range outputs {
		disk, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil || !bytes.Equal(disk, content) {
			diffs = append(diffs, rel)
		}
	}
	sort.Strings(diffs)
	return diffs, nil
}
