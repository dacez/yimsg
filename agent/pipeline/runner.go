// Package pipeline 把单个账号的完整处理链路串起来：连接/重连 yimsg、把
// cli/store 本地镜像增量追平、按 §4 语义拉取未处理消息并按 peer 分组、逐组交给
// agent/engine 处理、通过 yimsg 发送进度通知与最终回复、推进 agent/state 的
// 处理进度游标与记忆。方案见 agent/docs/agent方案.md 第 4、5 节。
package pipeline

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"yimsg/agent/config"
	"yimsg/agent/deepseek"
	"yimsg/agent/engine"
	"yimsg/agent/fsread"
	"yimsg/agent/state"
	"yimsg/cli/account"
	"yimsg/cli/client"
	"yimsg/cli/msgid"
	clistore "yimsg/cli/store"
	"yimsg/protocol/generated/go/pb"
)

// syncBatchLimit 是 sync_messages 单批拉取条数，与 cli 默认值一致。
const syncBatchLimit = 200

// AccountRunner 是单个账号的处理循环载体，只服务一个账号，不同账号各自独立实例。
type AccountRunner struct {
	dataDir  string
	server   string
	insecure bool
	username string
	password string
	maxPull  int

	memoryMaxChars int

	sess   account.Session
	conn   *client.Client
	store  *clistore.Store
	state  *state.Store
	engine *engine.Engine
}

// New 建立账号的首次连接（复用本地已保存 token 或全新登录）、按用户名打开本地
// 同步库与 agent 状态文件。ai 是共享的 DeepSeek 客户端，sandbox 是全部账号共享
// 的只读知识库沙箱（<data_dir>/resources，由 runtime 统一构建一次后传入，见
// agent方案.md §2.3），两者都无状态，所有账号可以共用同一份。
func New(cfg *config.Config, acc config.Account, ai *deepseek.Client, sandbox *fsread.Sandbox) (*AccountRunner, error) {
	sess, conn, err := bootstrapSession(cfg.DataDir, acc.Username, acc.Password, cfg.Server, cfg.InsecureSkipVerify)
	if err != nil {
		return nil, fmt.Errorf("账号 %q 建立连接失败: %w", acc.Username, err)
	}

	st, err := clistore.Open(account.DataPath(cfg.DataDir, sess.Username))
	if err != nil {
		conn.Close()
		return nil, err
	}
	if err := st.CacheUser(sess.UID, sess.Username); err != nil {
		conn.Close()
		st.Close()
		return nil, err
	}

	statePath := filepath.Join(account.Dir(cfg.DataDir, sess.Username), "agent_state.json")
	stateStore, err := state.Open(statePath, cfg.MemoryMaxCharsPerPeer, cfg.MemoryMaxPeers)
	if err != nil {
		conn.Close()
		st.Close()
		return nil, err
	}

	return &AccountRunner{
		dataDir:        cfg.DataDir,
		server:         cfg.Server,
		insecure:       cfg.InsecureSkipVerify,
		username:       acc.Username,
		password:       acc.Password,
		maxPull:        acc.MaxPull,
		memoryMaxChars: cfg.MemoryMaxCharsPerPeer,
		sess:           sess,
		conn:           conn,
		store:          st,
		state:          stateStore,
		engine:         engine.New(ai, sandbox, cfg.MaxPlanSteps, cfg.MaxToolCallsPerStep),
	}, nil
}

// Username 返回该 Runner 对应的账号用户名，供 runtime 记录日志。
func (r *AccountRunner) Username() string { return r.username }

// Close 释放本账号持有的连接与本地库句柄。
func (r *AccountRunner) Close() {
	r.disconnect()
	if r.store != nil {
		r.store.Close()
	}
}

// PollOnce 执行一轮：必要时重连、把本地镜像增量追平、拉取未处理消息、按 peer
// 分组顺序处理。返回本轮成功处理的消息条数；某个分组失败时按 agent方案.md §4
// 的批内失败语义立即返回，已经成功的分组在返回前已经各自 Commit 落盘，不会因为
// 后面分组失败而丢失或重复处理。
func (r *AccountRunner) PollOnce(ctx context.Context) (int, error) {
	if err := r.ensureConnected(); err != nil {
		return 0, fmt.Errorf("连接失败: %w", err)
	}
	if err := r.syncToLocal(); err != nil {
		r.disconnect()
		return 0, fmt.Errorf("同步消息到本地失败: %w", err)
	}

	pending, err := r.store.Pending(r.sess.UID, r.state.ProcessedSeq(), r.maxPull, false)
	if err != nil {
		return 0, fmt.Errorf("查询待处理消息失败: %w", err)
	}
	if len(pending) == 0 {
		return 0, nil
	}

	processed := 0
	for _, g := range groupByPeer(pending) {
		if err := r.processGroup(ctx, g); err != nil {
			return processed, fmt.Errorf("处理 peer=%s 失败: %w", g.peerKey, err)
		}
		processed += len(g.messages)
	}
	return processed, nil
}

// processGroup 处理一个 peer 分组：读记忆 → 交给 engine → 发最终回复 → 生成新
// 记忆摘要 → 原子推进游标与记忆。engine 内部的每步进度通知通过 sendText 直接发出。
func (r *AccountRunner) processGroup(ctx context.Context, g messageGroup) error {
	peerMem := r.state.PeerMemory(g.peerKey)
	userText := buildUserText(g.messages)
	target := g.target.toConversationTarget()

	result, err := r.engine.Run(ctx, engine.Request{
		SystemPrompt:  systemPromptFor(r.username),
		MemorySummary: peerMem.Summary,
		UserText:      userText,
	}, func(text string) error {
		return r.sendText(target, text)
	})
	if err != nil {
		return err
	}
	if err := r.sendText(target, result.FinalAnswer); err != nil {
		return err
	}

	newSummary, err := r.engine.Reflect(ctx, peerMem.Summary, userText, result.FinalAnswer, r.memoryMaxChars)
	if err != nil {
		// 记忆压缩失败不应该丢弃已经成功送达的回复，退化为保留旧摘要，
		// 下一轮再次尝试压缩。
		newSummary = peerMem.Summary
	}

	return r.state.Commit(g.maxSeq, []state.PeerUpdate{{Key: g.peerKey, Summary: newSummary}})
}

func buildUserText(msgs []clistore.StoredMessage) string {
	if len(msgs) == 1 {
		return extractText(msgs[0].Body)
	}
	var b strings.Builder
	for i, m := range msgs {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "[uid=%d] %s", m.FromUID, extractText(m.Body))
	}
	return b.String()
}

func systemPromptFor(username string) string {
	return fmt.Sprintf("你是 yimsg 平台上账号 %s 的自动回复助手，请用简洁、礼貌的中文回答对方的问题；不清楚的信息不要编造。", username)
}

// sendText 发一条纯文本消息；出错时视为连接不可信，主动断开以便下一次调用触发重连。
func (r *AccountRunner) sendText(target *pb.ConversationTarget, text string) error {
	if err := r.ensureConnected(); err != nil {
		return err
	}
	_, err := r.conn.SendMessage(&pb.SendMessageRequest{
		Target:  target,
		MsgType: pb.MessageType_MESSAGE_TYPE_TEXT,
		Body:    &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}},
		MsgId:   msgid.Generate(),
	})
	if err != nil {
		r.disconnect()
		return err
	}
	return nil
}

func (r *AccountRunner) syncToLocal() error {
	lastSeq, err := r.store.LastSyncedSeq()
	if err != nil {
		return err
	}
	for {
		resp, err := r.conn.SyncMessages(&pb.SyncMessagesRequest{LastSeq: lastSeq, Limit: syncBatchLimit})
		if err != nil {
			return err
		}
		if _, err := r.store.SaveMessages(r.sess.UID, resp.GetMessages()); err != nil {
			return err
		}
		if resp.GetCursorSeq() > 0 {
			lastSeq = resp.GetCursorSeq()
		}
		if !resp.GetHasMore() {
			break
		}
	}
	return nil
}

func (r *AccountRunner) ensureConnected() error {
	if r.conn != nil {
		return nil
	}
	sess, conn, err := bootstrapSession(r.dataDir, r.username, r.password, r.server, r.insecure)
	if err != nil {
		return err
	}
	r.sess = sess
	r.conn = conn
	return nil
}

func (r *AccountRunner) disconnect() {
	if r.conn != nil {
		r.conn.Close()
		r.conn = nil
	}
}
