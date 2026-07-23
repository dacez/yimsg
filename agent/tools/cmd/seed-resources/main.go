// seed-resources 清空并重建整个 yimsg-agent 数据根目录（data_dir），然后写入内置的知识库
// 内容：全部客服共享的 <data_dir>/resources/ 与各客服账号私有的 <data_dir>/<username>/resources/。
// 知识库内容随代码版本管理、内置在本工具里，不再依赖人工 SSH 到服务器手工维护 .md 文件；跟
// server/tools/cmd/seed-demo 每次部署清空并重建 /opt/yimsg/data 是同一套思路。目录结构见
// agent/docs/agent方案.md §2.3。
//
// data_dir 下除知识库外还有每个账号的 session.json/data.db/agent_state.json（本地 session、
// 消息同步镜像、uid<->username 缓存）。这些状态必须和知识库一起整体清空：yimsg 侧的
// seed-demo 每次部署都会重新注册 demo_kf_1~3，分配全新的 uid，如果只清空知识库、保留旧的
// data.db，cli/store.CacheUser 会因为同一个 username 对应了新旧两个不同的 uid 而触发
// users 表的 UNIQUE(username) 冲突，导致 yimsg-agent 初始化死循环重试（见
// docs/deployment/部署方案.md §13.7 的教训记录）。
//
// 用法:
//
//	go run ./agent/tools/cmd/seed-resources -data-dir /opt/yimsg/agent_data
//
// 本工具不解析 agent.toml、不依赖 DeepSeek API Key，只关心 data_dir，避免在部署时
// DeepSeek Key 尚未人工配置的情况下阻塞知识库初始化。
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	pathpkg "path"
	"path/filepath"
)

//go:embed content
var contentFS embed.FS

const (
	contentRoot   = "content"
	sharedDirName = "shared"
)

func main() {
	dataDir := flag.String("data-dir", "./agent_data", "yimsg-agent 数据根目录（对应 agent.toml 的 agent.data_dir）")
	flag.Parse()

	// 整体清空 data_dir：连同每个账号的 session.json/data.db/agent_state.json 一起重置，
	// 不能只清知识库子目录，见上面包注释里 UNIQUE(username) 冲突的教训。
	if err := os.RemoveAll(*dataDir); err != nil {
		log.Fatalf("清空 data_dir %s 失败: %v", *dataDir, err)
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatalf("创建 data_dir %s 失败: %v", *dataDir, err)
	}

	entries, err := fs.ReadDir(contentFS, contentRoot)
	if err != nil {
		log.Fatalf("读取内置知识库内容失败: %v", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		target := filepath.Join(*dataDir, "resources")
		if name != sharedDirName {
			target = filepath.Join(*dataDir, name, "resources")
		}
		if err := rewriteDir(pathpkg.Join(contentRoot, name), target); err != nil {
			log.Fatalf("写入 %s 失败: %v", target, err)
		}
		fmt.Printf("已写入知识库: %s\n", target)
	}
}

// rewriteDir 清空 target 目录后，把 embed.FS 里 src 目录下的全部文件原样复制过去。
// src 是 io/fs 风格路径（固定用 /），target 是本地文件系统路径。
func rewriteDir(src, target string) error {
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("清空目录失败: %w", err)
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	files, err := fs.ReadDir(contentFS, src)
	if err != nil {
		return err
	}
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		data, err := fs.ReadFile(contentFS, pathpkg.Join(src, f.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(target, f.Name()), data, 0o600); err != nil {
			return fmt.Errorf("写入文件失败: %w", err)
		}
	}
	return nil
}
