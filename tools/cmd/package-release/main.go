package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func main() {
	source := flag.String("source", "", "要打包的目录")
	output := flag.String("output", "", "输出 .zip 或 .tar.gz 文件")
	flag.Parse()
	if *source == "" || *output == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := createArchive(*source, *output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func createArchive(source, output string) error {
	info, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("读取打包目录: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("打包源必须是目录: %s", source)
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return fmt.Errorf("创建输出目录: %w", err)
	}

	switch {
	case strings.HasSuffix(output, ".zip"):
		return createZip(source, output)
	case strings.HasSuffix(output, ".tar.gz"):
		return createTarGz(source, output)
	default:
		return fmt.Errorf("不支持的压缩格式: %s", output)
	}
}

func createZip(source, output string) (resultErr error) {
	file, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("创建 zip: %w", err)
	}
	defer closeWithError(file, &resultErr)

	writer := zip.NewWriter(file)
	defer closeWithError(writer, &resultErr)
	return walkArchiveSource(source, func(name, sourcePath string, info os.FileInfo) error {
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = name
		if info.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Deflate
		}
		entry, err := writer.CreateHeader(header)
		if err != nil || info.IsDir() {
			return err
		}
		return copyFile(entry, sourcePath)
	})
}

func createTarGz(source, output string) (resultErr error) {
	file, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("创建 tar.gz: %w", err)
	}
	defer closeWithError(file, &resultErr)

	gzipWriter := gzip.NewWriter(file)
	defer closeWithError(gzipWriter, &resultErr)
	tarWriter := tar.NewWriter(gzipWriter)
	defer closeWithError(tarWriter, &resultErr)

	return walkArchiveSource(source, func(name, sourcePath string, info os.FileInfo) error {
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = name
		if err := tarWriter.WriteHeader(header); err != nil || info.IsDir() {
			return err
		}
		return copyFile(tarWriter, sourcePath)
	})
}

func walkArchiveSource(source string, visit func(name, sourcePath string, info os.FileInfo) error) error {
	rootName := filepath.Base(filepath.Clean(source))
	return filepath.Walk(source, func(current string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("发行包不接受符号链接: %s", current)
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		name := rootName
		if relative != "." {
			name = path.Join(rootName, filepath.ToSlash(relative))
		}
		return visit(name, current, info)
	})
}

func copyFile(destination io.Writer, sourcePath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	_, err = io.Copy(destination, source)
	return err
}

func closeWithError(closer io.Closer, resultErr *error) {
	if err := closer.Close(); *resultErr == nil && err != nil {
		*resultErr = err
	}
}
