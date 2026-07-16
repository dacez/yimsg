// Command protocolgen 以 protocol/yimsg.proto 为唯一事实源，
// 刷新 protobuf 生成物（pb.go / yimsg.ts），并生成 Go / TypeScript 两端的
// 协议机械映射代码与协议文档。
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"yimsg/tools/protocolgen"
)

func main() {
	check := flag.Bool("check", false, "重新生成全部生成物并与仓库内容比较，不一致则失败")
	flag.Parse()

	root, err := findRepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// 第一步：刷新 protoc 产出的 pb.go / yimsg.ts。
	if err := runStandardCodegen(root); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if *check {
		if err := runCheck(root); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("协议生成物校验通过。")
		return
	}

	if err := protocolgen.WriteOutputs(root); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("协议生成物已更新。")
}

func runCheck(root string) error {
	// protoc 产出物用 git diff 校验。
	cmd := exec.Command("git", "diff", "--exit-code", "--",
		"protocol/generated/go/pb/yimsg.pb.go",
		"protocol/generated/typescript/yimsg.ts",
		"server/internal/service/taskpb/taskpayload.pb.go",
	)
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("protobuf 生成物不是最新，请运行：go run ./tools/cmd/protocolgen\n%s", out)
	}
	// 其余生成物在内存中重新生成并逐字节比较。
	diffs, err := protocolgen.CheckOutputs(root)
	if err != nil {
		return err
	}
	if len(diffs) > 0 {
		return fmt.Errorf("以下生成物不是最新，请运行 go run ./tools/cmd/protocolgen：\n  %s", strings.Join(diffs, "\n  "))
	}
	return nil
}

func runStandardCodegen(root string) error {
	protoc := filepath.Join(root, "node_modules", ".bin", "grpc_tools_node_protoc")
	tsPlugin := filepath.Join(root, "node_modules", ".bin", "protoc-gen-ts_proto")
	if runtime.GOOS == "windows" {
		// npm 在 Windows 下为 shell script 生成 .cmd 包装，protoc 直接以子进程方式
		// 执行插件路径，必须指向 .cmd 而非无扩展名的 POSIX shell script。
		tsPlugin += ".cmd"
	}
	goPlugin := filepath.Join(os.Getenv("GOPATH"), "bin", "protoc-gen-go")
	if os.Getenv("GOPATH") == "" {
		if out, err := exec.Command("go", "env", "GOPATH").Output(); err == nil {
			goPlugin = filepath.Join(strings.TrimSpace(string(out)), "bin", "protoc-gen-go")
		} else {
			goPlugin = filepath.Join(os.Getenv("HOME"), "go", "bin", "protoc-gen-go")
		}
	}
	if runtime.GOOS == "windows" {
		goPlugin += ".exe"
	}
	if _, err := os.Stat(protoc); err != nil {
		return fmt.Errorf("未找到 protoc，请在仓库根目录运行 npm ci 或 npm install: %w", err)
	}
	if _, err := os.Stat(tsPlugin); err != nil {
		return fmt.Errorf("未找到 protoc-gen-ts_proto，请在仓库根目录运行 npm ci 或 npm install: %w", err)
	}
	if _, err := os.Stat(goPlugin); err != nil {
		return fmt.Errorf("未找到 protoc-gen-go，请运行 go install google.golang.org/protobuf/cmd/protoc-gen-go@latest: %w", err)
	}

	protoDir := filepath.Join(root, "protocol")
	goCmd := exec.Command(
		protoc,
		"-I", protoDir,
		"--plugin=protoc-gen-go="+goPlugin,
		"--go_out="+root,
		"--go_opt=module=yimsg",
		"yimsg.proto",
	)
	goCmd.Dir = protoDir
	if out, err := goCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("生成 Go protobuf 失败: %v\n%s", err, out)
	}
	if err := ensureSPDX(filepath.Join(root, "protocol", "generated", "go", "pb", "yimsg.pb.go"), "Apache-2.0"); err != nil {
		return err
	}

	tsOut := filepath.Join(root, "protocol", "generated", "typescript")
	if err := os.MkdirAll(tsOut, 0o755); err != nil {
		return fmt.Errorf("创建 TypeScript protobuf 输出目录失败: %w", err)
	}
	tsCmd := exec.Command(
		protoc,
		"-I", protoDir,
		"--plugin=protoc-gen-ts_proto="+tsPlugin,
		"--ts_proto_out="+tsOut,
		"--ts_proto_opt=esModuleInterop=true,forceLong=string,useExactTypes=false,snakeToCamel=false,outputJsonMethods=true,outputEncodeMethods=true,unrecognizedEnum=false",
		"yimsg.proto",
	)
	tsCmd.Dir = protoDir
	if out, err := tsCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("生成 TypeScript protobuf 失败: %v\n%s", err, out)
	}
	if err := ensureSPDX(filepath.Join(tsOut, "yimsg.ts"), "Apache-2.0"); err != nil {
		return err
	}

	// 服务端内部持久任务载荷独立于公开协议，但由同一入口刷新并标记 AGPL，
	// 避免手工执行 protoc 时遗漏目录变化或许可证头。
	taskProtoDir := filepath.Join(root, "server", "internal", "service")
	taskCmd := exec.Command(
		protoc,
		"-I", taskProtoDir,
		"--plugin=protoc-gen-go="+goPlugin,
		"--go_out="+root,
		"--go_opt=module=yimsg",
		"taskpayload.proto",
	)
	taskCmd.Dir = taskProtoDir
	if out, err := taskCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("生成服务端任务 protobuf 失败: %v\n%s", err, out)
	}
	if err := ensureSPDX(filepath.Join(taskProtoDir, "taskpb", "taskpayload.pb.go"), "AGPL-3.0-only"); err != nil {
		return err
	}
	return nil
}

// ensureSPDX 统一给 protoc 生成物补充许可证标识，避免手工修改生成文件。
func ensureSPDX(path, license string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取生成物 %s 失败: %w", path, err)
	}
	header := []byte("// SPDX-License-Identifier: " + license + "\n")
	if strings.HasPrefix(string(data), string(header)) {
		return nil
	}
	if err := os.WriteFile(path, append(header, data...), 0o644); err != nil {
		return fmt.Errorf("写入生成物 SPDX %s 失败: %w", path, err)
	}
	return nil
}

func findRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("未找到 go.mod，请从仓库内运行")
		}
	}
}
