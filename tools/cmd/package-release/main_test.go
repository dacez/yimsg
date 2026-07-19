package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateArchive(t *testing.T) {
	source := filepath.Join(t.TempDir(), "yimsg-0.1.0-test")
	if err := os.MkdirAll(filepath.Join(source, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "yimsg"), []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "web", "index.html"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("zip", func(t *testing.T) {
		output := filepath.Join(t.TempDir(), "release.zip")
		if err := createArchive(source, output); err != nil {
			t.Fatalf("createArchive: %v", err)
		}
		reader, err := zip.OpenReader(output)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		assertArchiveNames(t, zipNames(reader.File))
	})

	t.Run("tar.gz", func(t *testing.T) {
		output := filepath.Join(t.TempDir(), "release.tar.gz")
		if err := createArchive(source, output); err != nil {
			t.Fatalf("createArchive: %v", err)
		}
		file, err := os.Open(output)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		compressed, err := gzip.NewReader(file)
		if err != nil {
			t.Fatal(err)
		}
		defer compressed.Close()
		reader := tar.NewReader(compressed)
		var names []string
		for {
			header, err := reader.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, header.Name)
		}
		assertArchiveNames(t, names)
	})
}

func zipNames(files []*zip.File) []string {
	names := make([]string, 0, len(files))
	for _, file := range files {
		names = append(names, file.Name)
	}
	return names
}

func assertArchiveNames(t *testing.T, names []string) {
	t.Helper()
	want := map[string]bool{
		"yimsg-0.1.0-test":                false,
		"yimsg-0.1.0-test/yimsg":          false,
		"yimsg-0.1.0-test/web":            false,
		"yimsg-0.1.0-test/web/index.html": false,
	}
	for _, name := range names {
		name = strings.TrimSuffix(name, "/")
		if _, ok := want[name]; ok {
			want[name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("archive missing %q; entries: %v", name, names)
		}
	}
}
