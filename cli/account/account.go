// Package account 管理 yimsg-cli 的本地账号目录布局：CLI 使用方指定一个根目录，
// 二级目录固定为用户 uid（见 cli/docs/cli方案.md），每个账号目录下保存登录态
// session.json 与本地同步库 data.db，多账号互不干扰、无需用户区分不同文件夹。
//
// "当前账号"：根目录下另有一个 current.json 指针，记录"未显式 switch-user 时
// 默认操作哪个账号"，login 会自动把新登录的账号设为当前账号。子命令一律不接受
// 自己的 uid 作为参数（协议本身也不需要——身份永远来自已鉴权连接的 token，见
// server/internal/service 对 BaseInfo 的用法），只有 login / switch-user 需要
// 知道"要操作哪个账号"，其它命令统一读取 current.json。
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
const currentFileName = "current.json"

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

// currentPointer 只存 uid/username，token 等字段以 <uid>/session.json 为唯一
// 权威来源，避免出现两份可能不一致的 token 副本。
type currentPointer struct {
	UID      int64  `json:"uid"`
	Username string `json:"username"`
}

func currentPath(baseDir string) string {
	return filepath.Join(baseDir, currentFileName)
}

// SetCurrent 把 s 设为当前账号：未显式 switch-user 时，其它子命令默认操作它。
func SetCurrent(baseDir string, s Session) error {
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return fmt.Errorf("create base dir: %w", err)
	}
	data, err := json.MarshalIndent(currentPointer{UID: s.UID, Username: s.Username}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal current pointer: %w", err)
	}
	if err := os.WriteFile(currentPath(baseDir), data, 0o600); err != nil {
		return fmt.Errorf("write current pointer: %w", err)
	}
	return nil
}

// LoadCurrent 读取当前账号的完整登录态。current.json 只是指针，token 以
// <uid>/session.json 为准重新读取，确保 SwitchUser 之后拿到的始终是最新 token。
func LoadCurrent(baseDir string) (Session, error) {
	data, err := os.ReadFile(currentPath(baseDir))
	if err != nil {
		return Session{}, fmt.Errorf("尚未登录或未选择当前账号，请先执行 login 或 switch-user: %w", err)
	}
	var ptr currentPointer
	if err := json.Unmarshal(data, &ptr); err != nil {
		return Session{}, fmt.Errorf("parse current pointer: %w", err)
	}
	return Load(baseDir, ptr.UID)
}

// FindByUsername 在本地已登录账号中按用户名查找，供 switch-user 使用。
func FindByUsername(baseDir, username string) (Session, error) {
	sessions, err := List(baseDir)
	if err != nil {
		return Session{}, err
	}
	for _, s := range sessions {
		if s.Username == username {
			return s, nil
		}
	}
	return Session{}, fmt.Errorf("本地未找到账号 %q，请先执行 login", username)
}
