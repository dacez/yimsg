// Package account 管理 yimsg-cli 的本地账号目录布局：CLI 使用方指定一个根目录，
// 二级目录固定为用户 uid（见 cli/docs/cli方案.md），每个账号目录下保存登录态
// session.json 与本地同步库 data.db，多账号互不干扰、无需用户区分不同文件夹。
package account

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Session 是一个账号的本地登录态。
type Session struct {
	UID       int64  `json:"uid"`
	Username  string `json:"username"`
	Token     string `json:"token"`
	ServerURL string `json:"server_url"`
	LoginAt   int64  `json:"login_at"`
}

const sessionFileName = "session.json"
const dataFileName = "data.db"

// Dir 返回账号目录：<baseDir>/<uid>。
func Dir(baseDir string, uid int64) string {
	return filepath.Join(baseDir, strconv.FormatInt(uid, 10))
}

// SessionPath 返回账号登录态文件路径。
func SessionPath(baseDir string, uid int64) string {
	return filepath.Join(Dir(baseDir, uid), sessionFileName)
}

// DataPath 返回账号本地同步库路径。
func DataPath(baseDir string, uid int64) string {
	return filepath.Join(Dir(baseDir, uid), dataFileName)
}

// Save 把 session 写入 <baseDir>/<uid>/session.json，账号目录不存在则创建。
func Save(baseDir string, s Session) error {
	dir := Dir(baseDir, s.UID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create account dir: %w", err)
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}
	if err := os.WriteFile(SessionPath(baseDir, s.UID), data, 0o600); err != nil {
		return fmt.Errorf("write session: %w", err)
	}
	return nil
}

// Load 读取指定 uid 的本地登录态；账号目录或 session.json 不存在时返回错误，
// 调用方应提示先执行 login。
func Load(baseDir string, uid int64) (Session, error) {
	var s Session
	data, err := os.ReadFile(SessionPath(baseDir, uid))
	if err != nil {
		return s, fmt.Errorf("read session for uid=%d（可能尚未登录，请先执行 login）: %w", uid, err)
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("parse session for uid=%d: %w", uid, err)
	}
	return s, nil
}

// List 扫描 baseDir 下所有形如 <uid>/session.json 的账号目录，返回全部已登录账号。
func List(baseDir string) ([]Session, error) {
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read base dir: %w", err)
	}
	var sessions []Session
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		uid, err := strconv.ParseInt(entry.Name(), 10, 64)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(baseDir, entry.Name(), sessionFileName))
		if err != nil {
			continue
		}
		var s Session
		if err := json.Unmarshal(data, &s); err != nil {
			continue
		}
		if s.UID == 0 {
			s.UID = uid
		}
		sessions = append(sessions, s)
	}
	return sessions, nil
}
