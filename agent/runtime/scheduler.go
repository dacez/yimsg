// Package runtime 是 yimsg-agent 的多账号调度器：每个账号一个独立 goroutine，
// 按各自的轮询间隔调用 agent/pipeline，互不阻塞；连接失败时按指数退避重连，
// panic 被 recover 后只影响该账号自己。方案见 agent/docs/agent方案.md 第 4、9 节。
package runtime

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"yimsg/agent/config"
	"yimsg/agent/deepseek"
	"yimsg/agent/fsread"
	"yimsg/agent/pipeline"
)

const (
	initialBackoff = 2 * time.Second
	maxBackoff     = 16 * time.Second
)

// Runner 持有所有账号共用的 DeepSeek 客户端、共享只读知识库沙箱与全局配置，
// Run 启动全部账号的处理循环并阻塞直到 ctx 被取消。每个账号自己独享的知识库沙箱
// 按账号单独构建（见 newAccountRunner），不是这里的单例。
type Runner struct {
	cfg           *config.Config
	ai            *deepseek.Client
	sharedSandbox *fsread.Sandbox
}

// New 构造一个 Runner：DeepSeek 客户端与 <data_dir>/resources 共享只读知识库
// 沙箱都是全部账号共用的单例（见 agent方案.md §2.3），这里只构建一次；每个账号
// 自己的私有知识库沙箱在 newAccountRunner 里按账号各自构建。
func New(cfg *config.Config) (*Runner, error) {
	ds := cfg.DeepSeek
	ai := deepseek.New(ds.BaseURL, ds.APIKey, ds.Model, ds.Temperature, ds.RequestTimeout)
	sandbox, err := fsread.NewSandbox(cfg.ResourcesDir)
	if err != nil {
		return nil, fmt.Errorf("构建共享 resources 沙箱失败: %w", err)
	}
	return &Runner{cfg: cfg, ai: ai, sharedSandbox: sandbox}, nil
}

// Run 为每个账号启动一个独立 goroutine，阻塞直到 ctx 被取消且所有账号的当前
// 一轮处理都已结束（优雅关闭，见 agent方案.md §4"优雅关闭"）。
func (r *Runner) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, acc := range r.cfg.Accounts {
		wg.Add(1)
		go func(acc config.Account) {
			defer wg.Done()
			r.runAccount(ctx, acc)
		}(acc)
	}
	wg.Wait()
}

// runAccount 是单个账号的完整生命周期：先带退避重试地建立 Runner，再进入
// "按 ticker 轮询、失败退避、成功重置退避"的循环，直到 ctx 被取消。
func (r *Runner) runAccount(ctx context.Context, acc config.Account) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("[agent:%s] panic 已恢复，账号处理循环退出: %v", acc.Username, p)
		}
	}()

	runner := r.newRunnerWithRetry(ctx, acc)
	if runner == nil {
		return // ctx 在重试期间被取消
	}
	defer runner.Close()

	ticker := time.NewTicker(acc.PollInterval)
	defer ticker.Stop()

	backoff := initialBackoff
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n, err := runner.PollOnce(ctx)
			if err != nil {
				log.Printf("[agent:%s] 轮询失败: %v", acc.Username, err)
				if !sleepBackoff(ctx, backoff) {
					return
				}
				backoff = nextBackoff(backoff)
				continue
			}
			backoff = initialBackoff
			if n > 0 {
				log.Printf("[agent:%s] 本轮处理 %d 条消息", acc.Username, n)
			}
		}
	}
}

// newRunnerWithRetry 反复尝试 newAccountRunner 直到成功或 ctx 被取消。账号在完全
// 建立起身份（登录/token 校验）之前无法做任何事，因此这里的重试没有上限，只受
// ctx 控制。
func (r *Runner) newRunnerWithRetry(ctx context.Context, acc config.Account) *pipeline.AccountRunner {
	backoff := initialBackoff
	for {
		runner, err := r.newAccountRunner(acc)
		if err == nil {
			return runner
		}
		log.Printf("[agent:%s] 初始化失败，%s 后重试: %v", acc.Username, backoff, err)
		if !sleepBackoff(ctx, backoff) {
			return nil
		}
		backoff = nextBackoff(backoff)
	}
}

// newAccountRunner 为账号构建私有 resources 沙箱，与 Runner 持有的共享沙箱组合
// 成一个"先私有后共享"的 LayeredSandbox（见 agent方案.md §2.3），再交给 pipeline.New。
func (r *Runner) newAccountRunner(acc config.Account) (*pipeline.AccountRunner, error) {
	private, err := fsread.NewSandbox(acc.ResourcesDir)
	if err != nil {
		return nil, fmt.Errorf("构建账号 %q 的私有 resources 沙箱失败: %w", acc.Username, err)
	}
	fs := &fsread.LayeredSandbox{Private: private, Shared: r.sharedSandbox}
	return pipeline.New(r.cfg, acc, r.ai, fs)
}

func nextBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > maxBackoff {
		next = maxBackoff
	}
	return next
}

// sleepBackoff 睡眠 d，若期间 ctx 被取消则提前返回 false。
func sleepBackoff(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}
