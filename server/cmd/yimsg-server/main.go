package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/httpx"
	"yimsg/server/internal/plugin"
	"yimsg/server/internal/service"
	"yimsg/server/internal/shard"
	"yimsg/server/internal/taskqueue"
	"yimsg/server/internal/ws"
)

// taskQueueWorkers 是异步任务队列的并发 worker 数。任务 handler 幂等，乱序 / 并发安全。
const taskQueueWorkers = 8

func main() {
	opts, err := parseCommandOptions(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatalf("parse command: %v", err)
	}
	if opts.showVersion {
		fmt.Println(versionString())
		return
	}

	cfg, err := loadCommandConfig(opts)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("starting %s", versionString())

	// Ensure data and upload directories exist
	if err := os.MkdirAll(cfg.Database.DataDir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}
	if err := os.MkdirAll(cfg.Media.UploadDir, 0o755); err != nil {
		log.Fatalf("create upload dir: %v", err)
	}

	// 注册插件
	registry := plugin.NewRegistry()

	// 合并核心 schema + 插件 schema
	baseSchemas := dal.Schemas()
	allSchemas := registry.MergeSchemas(baseSchemas)

	// Open sharded database
	db, err := shard.Open(cfg.Database.DataDir, cfg.Database.ShardCount, allSchemas)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer db.Close()

	state := service.NewAppState(db, cfg, registry)

	// 打开持久化异步任务队列：群消息 / 群系统消息 fanout 都经由它异步执行，
	// 启动 worker 后重放崩溃前未完成的任务。
	tasks, err := taskqueue.Open(cfg.Database.DataDir)
	if err != nil {
		log.Fatalf("open task queue: %v", err)
	}
	defer tasks.Close()
	state.UseTaskQueue(tasks)
	tasks.SetAsync(taskQueueWorkers)
	if err := tasks.Recover(); err != nil {
		log.Printf("task queue recover: %v", err)
	}

	// Start GC
	service.StartGC(state)

	// 启动插件后台任务
	registry.Start(state)

	// Routes
	mux := http.NewServeMux()

	// 跨域策略：允许 [server] allowed_origins 中的第三方站点直接嵌入 UIKit
	// 并访问上传 / 媒体接口。未配置时整体关闭，同源部署行为不变。
	origins := httpx.NewOriginPolicy(cfg.Server.AllowedOrigins)

	// WebSocket
	mux.HandleFunc("/ws", ws.HandleWS(state))

	// Upload API
	mux.Handle("/api/upload", origins.Wrap(http.HandlerFunc(service.Upload(state))))

	// Serve uploaded files; resolves media by id (/media/{category}/{media_id}).
	mux.Handle("/media/", origins.Wrap(service.MediaHandler(cfg.Media.UploadDir)))

	// Static website (官网): 默认挂载根路径作为首页。
	if cfg.Website.StaticDir != "" && cfg.Website.MountPath != "" {
		siteFS := http.FileServer(http.Dir(cfg.Website.StaticDir))
		mux.Handle(cfg.Website.MountPath, http.StripPrefix(cfg.Website.MountPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			siteFS.ServeHTTP(w, r)
		})))
	}

	// Static frontend (聊天相关静态资源): 三个挂载点都经过跨域中间件，第三方站点
	// 可直接引用 /uikit/ 下的 bundle。这里不再设置 COOP/COEP——浏览器端已不使用
	// SQLite/OPFS，不需要跨域隔离，而跨域隔离反而会挡住第三方宿主页的嵌入。
	// StaticDir 下 app/、demo/、uikit/ 三个
	// 平级目录（真正需要注册登录的 App / 固定账号演示页 / 可嵌入第三方站点的
	// widget bundle）分别挂载在同名根路径下（/app/、/demo/、/uikit/），彼此
	// 平级、没有共同的 /chat/ 前缀，根路径留给官网首页。demo/、uikit/ 自身没
	// 有 index.html，挂载根路径显式 404 而不是让 http.FileServer 回落到目录
	// 列表，避免暴露内部目录结构；app/ 有 index.html，正常回落。
	if cfg.Frontend.StaticDir != "" {
		type frontendMount struct {
			sub       string
			guardRoot bool
		}
		mounts := []frontendMount{
			{sub: "app"},
			{sub: "demo", guardRoot: true},
			{sub: "uikit", guardRoot: true},
		}
		for _, m := range mounts {
			mountPath := "/" + m.sub + "/"
			fs := http.FileServer(http.Dir(filepath.Join(cfg.Frontend.StaticDir, m.sub)))
			guardRoot := m.guardRoot
			mux.Handle(mountPath, origins.Wrap(http.StripPrefix(mountPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if guardRoot && (r.URL.Path == "" || r.URL.Path == "/") {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
				fs.ServeHTTP(w, r)
			}))))
		}
	}

	addr := net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))
	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
		// Disable HTTP/2: gorilla/websocket does not support WebSocket over HTTP/2.
		TLSNextProto: make(map[string]func(*http.Server, *tls.Conn, http.Handler)),
	}

	// Graceful shutdown on SIGINT/SIGTERM
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("shutting down...")
		srv.Shutdown(context.Background())
	}()

	if cfg.Server.TLSCert != "" && cfg.Server.TLSKey != "" {
		log.Printf("yimsg server listening on %s (TLS)", addr)
		if err := srv.ListenAndServeTLS(cfg.Server.TLSCert, cfg.Server.TLSKey); err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	} else {
		log.Printf("yimsg server listening on %s", addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}
}
