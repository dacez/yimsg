package main

import (
	"path/filepath"
	"testing"

	"yimsg/server/internal/config"
)

func TestParseCommandOptionsZeroConfig(t *testing.T) {
	opts, err := parseCommandOptions([]string{"--listen", "0.0.0.0:8080", "--data-dir", "store"})
	if err != nil {
		t.Fatalf("parseCommandOptions: %v", err)
	}
	if opts.configPath != "" || opts.listen != "0.0.0.0:8080" || opts.dataDir != "store" {
		t.Fatalf("unexpected options: %+v", opts)
	}
}

func TestParseCommandOptionsKeepsPositionalConfigCompatibility(t *testing.T) {
	opts, err := parseCommandOptions([]string{"custom.toml"})
	if err != nil {
		t.Fatalf("parseCommandOptions: %v", err)
	}
	if opts.configPath != "custom.toml" {
		t.Fatalf("expected positional config path, got %q", opts.configPath)
	}
}

func TestParseListenAddress(t *testing.T) {
	tests := []struct {
		value string
		host  string
		port  int
	}{
		{"8080", config.DefaultServerHost, 8080},
		{"0.0.0.0:38081", "0.0.0.0", 38081},
		{"[::]:443", "::", 443},
	}
	for _, tt := range tests {
		host, port, err := parseListenAddress(tt.value)
		if err != nil {
			t.Fatalf("parseListenAddress(%q): %v", tt.value, err)
		}
		if host != tt.host || port != tt.port {
			t.Fatalf("parseListenAddress(%q) = %q, %d; want %q, %d", tt.value, host, port, tt.host, tt.port)
		}
	}
}

func TestParseListenAddressRejectsInvalidValue(t *testing.T) {
	for _, value := range []string{"", "localhost", "127.0.0.1:0", "127.0.0.1:70000"} {
		if _, _, err := parseListenAddress(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestApplyStandalonePathsUsesDistributionDirectory(t *testing.T) {
	cfg := config.Default()
	baseDir := filepath.Join("tmp", "yimsg")
	applyStandalonePaths(&cfg, baseDir)
	if cfg.Database.DataDir != filepath.Join(baseDir, "data") {
		t.Fatalf("unexpected data dir: %q", cfg.Database.DataDir)
	}
	if cfg.Media.UploadDir != filepath.Join(baseDir, "data", "media") {
		t.Fatalf("unexpected media dir: %q", cfg.Media.UploadDir)
	}
	if cfg.Frontend.StaticDir != filepath.Join(baseDir, "web") {
		t.Fatalf("unexpected frontend dir: %q", cfg.Frontend.StaticDir)
	}
	if cfg.Website.StaticDir != filepath.Join(baseDir, "website") {
		t.Fatalf("unexpected website dir: %q", cfg.Website.StaticDir)
	}
}
