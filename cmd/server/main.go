package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/plugin"
	"yimsg/internal/service"
	"yimsg/internal/shard"
	"yimsg/internal/taskqueue"
	"yimsg/internal/ws"
)

// taskQueueWorkers 是异步任务队列的并发 worker 数。任务 handler 幂等，乱序 / 并发安全。
const taskQueueWorkers = 8

func main() {
	cfgPath := "config.toml"
	if len(os.Args) > 1 {
		cfgPath = os.Args[1]
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

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

	// WebSocket
	mux.HandleFunc("/ws", ws.HandleWS(state))

	// Upload API
	mux.HandleFunc("/api/upload", service.Upload(state))

	// Serve uploaded files; resolves media by id (/media/{category}/{media_id}).
	mux.Handle("/media/", service.MediaHandler(cfg.Media.UploadDir))

	// Static website (官网): 默认挂载根路径作为首页。
	if cfg.Website.StaticDir != "" && cfg.Website.MountPath != "" {
		siteFS := http.FileServer(http.Dir(cfg.Website.StaticDir))
		mux.Handle(cfg.Website.MountPath, http.StripPrefix(cfg.Website.MountPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			siteFS.ServeHTTP(w, r)
		})))
	}

	// Static frontend (聊天 App): 默认挂载 /chat/ 子路径，不占用根路径。
	if cfg.Frontend.StaticDir != "" && cfg.Frontend.MountPath != "" {
		fs := http.FileServer(http.Dir(cfg.Frontend.StaticDir))
		mux.Handle(cfg.Frontend.MountPath, http.StripPrefix(cfg.Frontend.MountPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
			w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
			fs.ServeHTTP(w, r)
		})))
	}

	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
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
