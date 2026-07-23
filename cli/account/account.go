// Package account 管理 yimsg-cli / yimsg-agent 共用的本地账号目录布局：调用方
// 指定一个根目录，二级目录固定为用户名（而不是 uid——用户名在登录前就已知，
// 目录名对人类可读，方便直接在文件系统上分辨"这是哪个账号"），每个账号目录下
// 保存登录态 session.json 与本地同步库 data.db，多账号互不干扰、无需用户区分不同
// 文件夹。研发阶段不处理"同一用户名先后注册于不同服务器（不同 uid）"这种极端
// 场景：同一 username 目录直接复用/覆盖，与仓库其余本地状态"不做迁移、按需重建"
// 的一贯做法一致（见根 CLAUDE.md 项目不变量）。
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

// Dir 返回账号目录：<baseDir>/<username>。
func Dir(baseDir, username string) string {
	return filepath.Join(baseDir, username)
}

// SessionPath 返回账号登录态文件路径。
func SessionPath(baseDir, username string) string {
	return filepath.Join(Dir(baseDir, username), sessionFileName)
}

// DataPath 返回账号本地同步库路径。
func DataPath(baseDir, username string) string {
	return filepath.Join(Dir(baseDir, username), dataFileName)
}

// Save 把 session 写入 <baseDir>/<s.Username>/session.json，账号目录不存在则
// 创建；同一 username 已存在时直接覆盖（见包注释）。
func Save(baseDir string, s Session) error {
	if s.Username == "" {
		return fmt.Errorf("session 缺少 username，无法确定账号目录")
	}
	dir := Dir(baseDir, s.Username)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create account dir: %w", err)
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}
	if err := os.WriteFile(SessionPath(baseDir, s.Username), data, 0o600); err != nil {
		return fmt.Errorf("write session: %w", err)
	}
	return nil
}

// Load 读取指定用户名的本地登录态；账号目录或 session.json 不存在时返回错误，
// 调用方应提示先执行 login。
func Load(baseDir, username string) (Session, error) {
	var s Session
	data, err := os.ReadFile(SessionPath(baseDir, username))
	if err != nil {
		return s, fmt.Errorf("read session for username=%s（可能尚未登录，请先执行 login）: %w", username, err)
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("parse session for username=%s: %w", username, err)
	}
	return s, nil
}

// List 扫描 baseDir 下所有形如 <username>/session.json 的账号目录，返回全部
// 已登录账号；没有 session.json 的子目录（例如 yimsg-agent 的共享 resources/
// 目录）会被静默跳过，不是错误。
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
		data, err := os.ReadFile(filepath.Join(baseDir, entry.Name(), sessionFileName))
		if err != nil {
			continue
		}
		var s Session
		if err := json.Unmarshal(data, &s); err != nil {
			continue
		}
		if s.Username == "" {
			s.Username = entry.Name()
		}
		sessions = append(sessions, s)
	}
	return sessions, nil
}

// currentPointer 只存 uid/username，token 等字段以 <username>/session.json 为唯一
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
// <username>/session.json 为准重新读取，确保 SwitchUser 之后拿到的始终是最新 token。
func LoadCurrent(baseDir string) (Session, error) {
	data, err := os.ReadFile(currentPath(baseDir))
	if err != nil {
		return Session{}, fmt.Errorf("尚未登录或未选择当前账号，请先执行 login 或 switch-user: %w", err)
	}
	var ptr currentPointer
	if err := json.Unmarshal(data, &ptr); err != nil {
		return Session{}, fmt.Errorf("parse current pointer: %w", err)
	}
	return Load(baseDir, ptr.Username)
}

// FindByUsername 在本地已登录账号中按用户名查找，供 switch-user 使用；账号目录
// 本身就以 username 命名，因此直接尝试 Load 即可，不需要遍历。
func FindByUsername(baseDir, username string) (Session, error) {
	s, err := Load(baseDir, username)
	if err != nil {
		return Session{}, fmt.Errorf("本地未找到账号 %q，请先执行 login: %w", username, err)
	}
	return s, nil
}
