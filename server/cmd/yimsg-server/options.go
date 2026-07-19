package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"yimsg/server/internal/config"
)

type commandOptions struct {
	configPath  string
	listen      string
	dataDir     string
	showVersion bool
}

func parseCommandOptions(args []string) (commandOptions, error) {
	var opts commandOptions
	fs := flag.NewFlagSet("yimsg", flag.ContinueOnError)
	fs.StringVar(&opts.configPath, "config", "", "高级配置文件路径")
	fs.StringVar(&opts.listen, "listen", "", "监听地址，例如 127.0.0.1:38081 或 0.0.0.0:38081")
	fs.StringVar(&opts.dataDir, "data-dir", "", "数据目录，默认是程序目录下的 data")
	fs.BoolVar(&opts.showVersion, "version", false, "显示版本信息")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "用法: yimsg [选项] [config.toml]")
		fmt.Fprintln(fs.Output(), "不带参数即可使用内置默认值启动；config.toml 仅用于高级配置。")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return commandOptions{}, err
	}
	if fs.NArg() > 1 {
		return commandOptions{}, fmt.Errorf("最多只能指定一个配置文件")
	}
	if fs.NArg() == 1 {
		if opts.configPath != "" {
			return commandOptions{}, fmt.Errorf("配置文件不能同时使用 --config 和位置参数指定")
		}
		opts.configPath = fs.Arg(0)
	}
	return opts, nil
}

func loadCommandConfig(opts commandOptions) (*config.Config, error) {
	var cfg *config.Config
	if opts.configPath != "" {
		loaded, err := config.Load(opts.configPath)
		if err != nil {
			return nil, err
		}
		cfg = loaded
	} else {
		defaults := config.Default()
		cfg = &defaults
		baseDir, err := runtimeBaseDir()
		if err != nil {
			return nil, err
		}
		applyStandalonePaths(cfg, baseDir)
	}

	if opts.listen != "" {
		host, port, err := parseListenAddress(opts.listen)
		if err != nil {
			return nil, err
		}
		cfg.Server.Host = host
		cfg.Server.Port = port
	}
	if opts.dataDir != "" {
		cfg.Database.DataDir = opts.dataDir
		cfg.Media.UploadDir = filepath.Join(opts.dataDir, "media")
	}
	return cfg, nil
}

func parseListenAddress(value string) (string, int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", 0, fmt.Errorf("--listen 不能为空")
	}
	if port, err := strconv.Atoi(value); err == nil {
		if err := validatePort(port); err != nil {
			return "", 0, err
		}
		return config.DefaultServerHost, port, nil
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, fmt.Errorf("解析 --listen %q: %w", value, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return "", 0, fmt.Errorf("--listen 端口必须是整数: %q", portText)
	}
	if err := validatePort(port); err != nil {
		return "", 0, err
	}
	return host, port, nil
}

func validatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("监听端口必须在 1 到 65535 之间，当前是 %d", port)
	}
	return nil
}

func runtimeBaseDir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("读取当前目录: %w", err)
	}
	if hasRuntimeAssets(cwd) {
		return cwd, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("读取程序路径: %w", err)
	}
	executableDir := filepath.Dir(executable)
	if hasRuntimeAssets(executableDir) {
		return executableDir, nil
	}
	return cwd, nil
}

func hasRuntimeAssets(dir string) bool {
	for _, name := range []string{"web", "website"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}

func applyStandalonePaths(cfg *config.Config, baseDir string) {
	cfg.Database.DataDir = filepath.Join(baseDir, "data")
	cfg.Media.UploadDir = filepath.Join(baseDir, "data", "media")
	cfg.Frontend.StaticDir = filepath.Join(baseDir, "web")
	cfg.Website.StaticDir = filepath.Join(baseDir, "website")
}
