package pipeline

import (
	"fmt"
	"time"

	"yimsg/cli/account"
	"yimsg/cli/client"
)

// connectAuthedSession 拨号并用已保存的 token 恢复会话；token 失效时返回错误，
// 调用方应改走全新登录，而不是静默失败。写法与 cli/cmd/yimsg-cli 的同名逻辑一致，
// 但 cli 内部这段代码是 package main 未导出内容，agent 需要独立实现一份。
func connectAuthedSession(sess account.Session, insecure bool) (*client.Client, error) {
	c, err := client.Dial(sess.ServerURL, insecure)
	if err != nil {
		return nil, err
	}
	if _, err := c.Authenticate(sess.Token); err != nil {
		c.Close()
		return nil, fmt.Errorf("token 鉴权失败（可能已过期）: %w", err)
	}
	return c, nil
}

// bootstrapSession 建立一个账号的已鉴权连接：优先复用 dataDir 下按 username 找到
// 的本地已保存 session（token 校验通过即用），否则用 username/password 发起全新
// 登录并把新 session 落盘。返回的 Session.UID 用于后续按 uid 打开本地状态文件。
func bootstrapSession(dataDir, username, password, server string, insecure bool) (account.Session, *client.Client, error) {
	if sess, ok, err := findLocalSession(dataDir, username); err != nil {
		return account.Session{}, nil, err
	} else if ok {
		if c, err := connectAuthedSession(sess, insecure); err == nil {
			return sess, c, nil
		}
		// 本地 token 失效，继续走下面的全新登录。
	}

	c, err := client.Dial(server, insecure)
	if err != nil {
		return account.Session{}, nil, err
	}
	resp, err := c.Login(username, password)
	if err != nil {
		c.Close()
		return account.Session{}, nil, fmt.Errorf("登录账号 %q 失败: %w", username, err)
	}
	sess := account.Session{
		UID:       resp.GetUid(),
		Username:  username,
		Token:     resp.GetToken(),
		ServerURL: server,
		LoginAt:   time.Now().UnixMilli(),
	}
	if err := account.Save(dataDir, sess); err != nil {
		c.Close()
		return account.Session{}, nil, err
	}
	return sess, c, nil
}

// findLocalSession 在 dataDir 下按 username 查找本地已保存的登录态，不发起网络请求。
func findLocalSession(dataDir, username string) (account.Session, bool, error) {
	sessions, err := account.List(dataDir)
	if err != nil {
		return account.Session{}, false, err
	}
	for _, s := range sessions {
		if s.Username == username {
			return s, true, nil
		}
	}
	return account.Session{}, false, nil
}
