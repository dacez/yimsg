// 文档一致性校验工具（Go 重写版，替代原 Python 脚本）。
// 从仓库根目录运行：go run ./tools/cmd/check-docs-consistency/
package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	wsRe       = regexp.MustCompile(`\s+`)
	sepRowRe   = regexp.MustCompile(`^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$`)
	pkInlineRe = regexp.MustCompile(`\((.*?)\)`)
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	c := &checker{root: root}
	c.checkHeaders()
	c.checkAgentGuides()
	c.checkSchemaDoc()
	c.checkActionsDoc()
	c.checkSDKDoc()
	c.checkDocLinks()
	c.collectTestStats()
	c.warnReviewDates()
	if len(c.errors) > 0 {
		fmt.Println("文档一致性校验失败：")
		for _, e := range c.errors {
			fmt.Printf("- %s\n", e)
		}
		os.Exit(1)
	}
	fmt.Println("文档一致性校验通过。")
	c.printSummary()
}

// ─── 基础工具 ────────────────────────────────────────────────────────────────

type checker struct {
	root     string
	errors   []string
	warnings []string
	stats    consistencyStats
}

type consistencyStats struct {
	docFiles       int
	schemaTables   int
	schemaFields   int
	schemaIndexes  int
	wsActions      int
	httpInterfaces int
	sdkMethods     int
	goUnitFiles    int
	goUnitTests    int
	goE2EFiles     int
	goE2ETests     int
	goE2EHasMain   bool
	frontUnitFiles int
	frontUnitTests int
	frontSDKFiles  int
	frontSDKTests  int
	frontUIFiles   int
	frontUITests   int
}

func (c *checker) addError(msg string) {
	c.errors = append(c.errors, msg)
}

func (c *checker) printSummary() {
	if len(c.warnings) > 0 {
		fmt.Println("提示：")
		for _, w := range c.warnings {
			fmt.Printf("- %s\n", w)
		}
	}
	fmt.Println("校验范围：")
	fmt.Printf("- 文档头部模板：%d 个 Markdown 文件\n", c.stats.docFiles)
	fmt.Printf("- Schema：%d 张表，%d 个字段，%d 个索引\n", c.stats.schemaTables, c.stats.schemaFields, c.stats.schemaIndexes)
	fmt.Printf("- 对外接口：%d 个 WebSocket Type action，%d 个 HTTP 接口\n", c.stats.wsActions, c.stats.httpInterfaces)
	fmt.Printf("- SDK 公开 API：%d 个方法\n", c.stats.sdkMethods)
	fmt.Println("测试用例统计：")
	fmt.Printf("- 服务端单元/组件：%d 个文件，%d 个业务测试\n", c.stats.goUnitFiles, c.stats.goUnitTests)
	mainNote := ""
	if c.stats.goE2EHasMain {
		mainNote = "，另有 TestMain 启动入口"
	}
	fmt.Printf("- 服务端 E2E：%d 个文件，%d 个业务测试%s\n", c.stats.goE2EFiles, c.stats.goE2ETests, mainNote)
	fmt.Printf("- 前端单元：%d 个文件，%d 个测试\n", c.stats.frontUnitFiles, c.stats.frontUnitTests)
	fmt.Printf("- 前端 SDK 集成：%d 个文件，%d 个测试\n", c.stats.frontSDKFiles, c.stats.frontSDKTests)
	fmt.Printf("- 前端 UI：%d 个文件，%d 个测试\n", c.stats.frontUIFiles, c.stats.frontUITests)
}

func (c *checker) readFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		c.addError(fmt.Sprintf("读取文件失败 %s: %v", path, err))
		return ""
	}
	return string(data)
}

// normalizeSQLFragment 等价于 Python:
// re.sub(r"\s+", " ", value.strip().rstrip(",")).upper()
func normalizeSQLFragment(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), ",")
	return strings.ToUpper(wsRe.ReplaceAllString(value, " "))
}

// markdownTableRows 解析 Markdown 表格行（跳过分隔行）。
func markdownTableRows(text string) [][]string {
	var rows [][]string
	for _, line := range strings.Split(text, "\n") {
		stripped := strings.TrimSpace(line)
		if !strings.HasPrefix(stripped, "|") || !strings.HasSuffix(stripped, "|") {
			continue
		}
		if sepRowRe.MatchString(stripped) {
			continue
		}
		inner := stripped[1 : len(stripped)-1]
		parts := strings.Split(inner, "|")
		cells := make([]string, len(parts))
		for i, p := range parts {
			cells[i] = strings.TrimSpace(p)
		}
		rows = append(rows, cells)
	}
	return rows
}

// ─── 1. 文档头部模板校验 ──────────────────────────────────────────────────────

func (c *checker) checkHeaders() {
	for _, relDir := range []string{"docs", "server/docs", "protocol/docs", "packages/sdk/docs", "packages/uikit/docs"} {
		docsDir := filepath.Join(c.root, relDir)
		err := filepath.WalkDir(docsDir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
				return err
			}
			c.stats.docFiles++
			text := c.readFile(path)
			lines := strings.SplitN(text, "\n", 11)
			if len(lines) > 10 {
				lines = lines[:10]
			}
			head := strings.Join(lines, "\n")
			rel, _ := filepath.Rel(c.root, path)
			for _, field := range []string{"主要对照", "最后复核", "触发更新"} {
				if !strings.Contains(head, fmt.Sprintf("> %s：", field)) {
					c.addError(fmt.Sprintf("%s 缺少头部模板字段：%s", rel, field))
				}
			}
			if !strings.Contains(head, "> 入口关系：") {
				c.addError(fmt.Sprintf("%s 缺少头部模板字段：入口关系", rel))
			}
			return nil
		})
		if err != nil {
			c.addError(fmt.Sprintf("遍历文档目录 %s 失败: %v", relDir, err))
		}
	}
}

// ─── 1.5 编码指南一致性校验 ───────────────────────────────────────────────────
//
// AGENTS.md、.github/copilot-instructions.md、CLAUDE.md 三份编码指南分别供
// Agent/Codex、GitHub Copilot、Claude 使用；除各自首行标题外，正文必须完全一致。

type agentGuide struct {
	path  string
	title string
}

func (c *checker) checkAgentGuides() {
	guides := []agentGuide{
		{path: "AGENTS.md", title: "# Yimsg Agent Guide"},
		{path: ".github/copilot-instructions.md", title: "# Yimsg Copilot Instructions"},
		{path: "CLAUDE.md", title: "# Yimsg Claude Guide"},
	}

	type parsed struct {
		path string
		body string
	}
	bodies := make([]parsed, 0, len(guides))
	for _, g := range guides {
		text := c.readFile(filepath.Join(c.root, g.path))
		if text == "" {
			continue
		}
		firstLine := text
		rest := ""
		if idx := strings.IndexByte(text, '\n'); idx >= 0 {
			firstLine = text[:idx]
			rest = text[idx+1:]
		}
		if strings.TrimSpace(firstLine) != g.title {
			c.addError(fmt.Sprintf("%s 首行标题应为 %q，实际为 %q", g.path, g.title, strings.TrimSpace(firstLine)))
		}
		bodies = append(bodies, parsed{path: g.path, body: rest})
	}

	if len(bodies) < len(guides) {
		// 缺文件已在 readFile 中报错，正文比对无意义。
		return
	}
	base := bodies[0]
	for _, other := range bodies[1:] {
		if other.body != base.body {
			c.addError(fmt.Sprintf("%s 与 %s 正文不一致（除首行标题外三份编码指南必须逐字一致）", other.path, base.path))
		}
	}
}

// ─── 2. Schema 文档校验 ───────────────────────────────────────────────────────

type tableInfo struct {
	columns    map[string]string
	primaryKey string
	indexes    []indexInfo
}

type indexInfo struct {
	name   string
	cols   string
	unique bool
}

var (
	createTableRe = regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\);`)
	createIndexRe = regexp.MustCompile(`(?s)CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\((.*?)\);`)
	docTableRe    = regexp.MustCompile("(?m)^###\\s+\\d+(?:\\.\\d+)?\\s+`([^`]+)`")
	nextHeadRe    = regexp.MustCompile("(?m)^###\\s+\\d+(?:\\.\\d+)?\\s+`")
	docColRe      = regexp.MustCompile("^`([^`]+)`$")
)

func parseSchemaTablesFromText(text string) map[string]*tableInfo {
	tables := make(map[string]*tableInfo)
	for _, match := range createTableRe.FindAllStringSubmatch(text, -1) {
		tableName := match[1]
		body := match[2]
		info := &tableInfo{columns: make(map[string]string)}
		for _, rawLine := range strings.Split(body, "\n") {
			line := strings.TrimRight(strings.TrimSpace(rawLine), ",")
			if line == "" {
				continue
			}
			upper := strings.ToUpper(line)
			if strings.HasPrefix(upper, "PRIMARY KEY") {
				if m := pkInlineRe.FindStringSubmatch(line); m != nil {
					info.primaryKey = strings.ReplaceAll(m[1], " ", "")
				}
				continue
			}
			if strings.HasPrefix(upper, "CONSTRAINT") || strings.HasPrefix(upper, "UNIQUE") || strings.HasPrefix(upper, "FOREIGN") {
				continue
			}
			parts := wsRe.Split(strings.TrimSpace(line), 2)
			if len(parts) == 2 {
				colName := strings.Trim(parts[0], "`\"")
				info.columns[colName] = normalizeSQLFragment(parts[1])
			}
		}
		tables[tableName] = info
	}
	for _, match := range createIndexRe.FindAllStringSubmatch(text, -1) {
		unique := match[1] != ""
		name := match[2]
		tableName := match[3]
		cols := strings.ReplaceAll(match[4], " ", "")
		if info, ok := tables[tableName]; ok {
			info.indexes = append(info.indexes, indexInfo{name: name, cols: cols, unique: unique})
		}
	}
	return tables
}

func (c *checker) checkSchemaDoc() {
	text := c.readFile(filepath.Join(c.root, "server/internal/dal/schema.go"))
	doc := c.readFile(filepath.Join(c.root, "server/docs/db/schema字段对照.md"))
	if text == "" || doc == "" {
		return
	}
	tables := parseSchemaTablesFromText(text)
	c.stats.schemaTables = len(tables)
	for _, info := range tables {
		c.stats.schemaFields += len(info.columns)
		c.stats.schemaIndexes += len(info.indexes)
	}

	documentedTables := make(map[string]bool)
	for _, m := range docTableRe.FindAllStringSubmatch(doc, -1) {
		documentedTables[m[1]] = true
	}

	tableNames := make([]string, 0, len(tables))
	for name := range tables {
		tableNames = append(tableNames, name)
	}
	sort.Strings(tableNames)

	var missingTables []string
	for _, name := range tableNames {
		if !documentedTables[name] {
			missingTables = append(missingTables, name)
		}
	}
	if len(missingTables) > 0 {
		c.addError("schema 字段对照缺少表：" + strings.Join(missingTables, ", "))
	}

	var extraTables []string
	for name := range documentedTables {
		if tables[name] == nil {
			extraTables = append(extraTables, name)
		}
	}
	sort.Strings(extraTables)
	if len(extraTables) > 0 {
		c.addError("schema 字段对照包含不存在的表：" + strings.Join(extraTables, ", "))
	}

	for _, tableName := range tableNames {
		info := tables[tableName]
		re := regexp.MustCompile(fmt.Sprintf("(?m)^###\\s+\\d+(?:\\.\\d+)?\\s+`%s`\\s*$", regexp.QuoteMeta(tableName)))
		headingIdx := re.FindStringIndex(doc)
		if headingIdx == nil {
			continue
		}
		remaining := doc[headingIdx[1]:]
		var section string
		if nm := nextHeadRe.FindStringIndex(remaining); nm != nil {
			section = remaining[:nm[0]]
		} else {
			section = remaining
		}

		// 从 section 解析文档中的列
		docColumns := make(map[string]string)
		for _, cells := range markdownTableRows(section) {
			if len(cells) < 2 {
				continue
			}
			m := docColRe.FindStringSubmatch(cells[0])
			if m == nil {
				continue
			}
			docColumns[m[1]] = normalizeSQLFragment(strings.Trim(cells[1], "`"))
		}

		colNames := make([]string, 0, len(info.columns))
		for col := range info.columns {
			colNames = append(colNames, col)
		}
		sort.Strings(colNames)
		for _, col := range colNames {
			constraint := info.columns[col]
			if docVal, ok := docColumns[col]; !ok {
				c.addError(fmt.Sprintf("schema 字段对照 %s 缺少字段：%s", tableName, col))
			} else if docVal != constraint {
				c.addError(fmt.Sprintf("schema 字段对照 %s.%s 约束不一致：文档=%s，代码=%s", tableName, col, docVal, constraint))
			}
		}

		// 校验主键
		if pk := info.primaryKey; pk != "" {
			compact := strings.ReplaceAll(section, " ", "")
			if !strings.Contains(compact, fmt.Sprintf("主键：`(%s)`", pk)) {
				c.addError(fmt.Sprintf("schema 字段对照 %s 缺少主键：(%s)", tableName, pk))
			}
		}

		// 校验索引
		for _, idx := range info.indexes {
			compact := strings.ReplaceAll(section, " ", "")
			if !strings.Contains(section, idx.name) || !strings.Contains(compact, fmt.Sprintf("(%s)", idx.cols)) {
				c.addError(fmt.Sprintf("schema 字段对照 %s 缺少索引：%s(%s)", tableName, idx.name, idx.cols))
			}
			if idx.unique {
				if pos := strings.Index(section, idx.name); pos >= 0 {
					end := pos + 80
					if end > len(section) {
						end = len(section)
					}
					if !strings.Contains(section[pos:end], "唯一") {
						c.addError(fmt.Sprintf("schema 字段对照 %s 索引 %s 缺少唯一说明", tableName, idx.name))
					}
				}
			}
		}
	}

	expectedCount := len(tables)
	if !strings.Contains(doc, fmt.Sprintf("%d 张表", expectedCount)) {
		c.addError(fmt.Sprintf("schema 字段对照总表数未写为 %d 张表", expectedCount))
	}
}

// ─── 3. Action 文档校验 ───────────────────────────────────────────────────────

var (
	protoActionRe   = regexp.MustCompile(`(?m)^\s*(TYPE_[A-Z0-9_]+)\s*=\s*\d+;\s*//\s*action=([a-z0-9_]+)\b`)
	caseTypeRe      = regexp.MustCompile(`case\s+pb\.Type_(TYPE_[A-Z0-9_]+)\s*:`)
	docActionCellRe = regexp.MustCompile("^`([^`]+)`$")
	mappedActionRe  = regexp.MustCompile("\\|\\s*`[^`]+`\\s*\\|\\s*`([^`]+)`\\s*\\|")
)

func (c *checker) checkActionsDoc() {
	// type -> request/response/方法 的映射现在由 protocolgen 生成到
	// server/internal/ws/action_dispatch_gen.go，连接层不再手写 dispatch switch。
	code := c.readFile(filepath.Join(c.root, "server/internal/ws/action_dispatch_gen.go"))
	proto := c.readFile(filepath.Join(c.root, "protocol/yimsg.proto"))
	doc := c.readFile(filepath.Join(c.root, "protocol/docs/接口总览.md"))
	if code == "" || proto == "" || doc == "" {
		return
	}

	switchStart := strings.Index(code, "switch pb.Type(typeID)")
	if switchStart < 0 {
		c.addError("action_dispatch_gen.go 中未找到 switch pb.Type(typeID)")
		return
	}
	var dispatchBody string
	if defaultPos := strings.Index(code[switchStart:], "default:"); defaultPos >= 0 {
		dispatchBody = code[switchStart : switchStart+defaultPos]
	} else {
		dispatchBody = code[switchStart:]
	}
	protoActions := make(map[string]bool)
	protoTypes := make(map[string]string)
	for _, m := range protoActionRe.FindAllStringSubmatch(proto, -1) {
		protoTypes[m[1]] = m[2]
		protoActions[m[2]] = true
	}

	dispatchTypes := make(map[string]bool)
	for _, m := range caseTypeRe.FindAllStringSubmatch(dispatchBody, -1) {
		dispatchTypes[m[1]] = true
	}
	c.stats.wsActions = len(protoActions)
	c.stats.httpInterfaces = 3

	var missingTypes []string
	for typeName := range protoTypes {
		if !dispatchTypes[typeName] {
			missingTypes = append(missingTypes, typeName)
		}
	}
	sort.Strings(missingTypes)
	if len(missingTypes) > 0 {
		c.addError("connection.go dispatch switch 缺少 Type：" + strings.Join(missingTypes, ", "))
	}

	secondChapterStart := strings.Index(doc, "### 3.1 WebSocket action 列表")
	summaryStart := strings.Index(doc, "### 3.2 对外接口汇总")
	if secondChapterStart < 0 || summaryStart < 0 {
		c.addError("接口总览缺少 WebSocket action 列表或汇总章节")
		return
	}
	secondChapter := doc[secondChapterStart:summaryStart]

	docActions := make(map[string]bool)
	for _, cells := range markdownTableRows(secondChapter) {
		if len(cells) >= 2 {
			if m := docActionCellRe.FindStringSubmatch(cells[1]); m != nil {
				docActions[m[1]] = true
			}
		}
	}

	var missingActions []string
	for action := range protoActions {
		if !docActions[action] {
			missingActions = append(missingActions, action)
		}
	}
	sort.Strings(missingActions)
	if len(missingActions) > 0 {
		c.addError("接口总览 WebSocket action 列表缺少 action：" + strings.Join(missingActions, ", "))
	}

	var extraActions []string
	for action := range docActions {
		if !protoActions[action] && action != "upload" {
			extraActions = append(extraActions, action)
		}
	}
	sort.Strings(extraActions)
	if len(extraActions) > 0 {
		c.addError("接口总览 WebSocket action 列表包含不存在的 action：" + strings.Join(extraActions, ", "))
	}

	// 校验 SDK ↔ 服务端 action 映射表（§ 3.2）
	mapStart := strings.Index(doc, "### 2.1 SDK ↔ 服务端 action 映射")
	if mapStart >= 0 {
		var mappingSection string
		if mapEnd := strings.Index(doc[mapStart:], "### 2.2"); mapEnd >= 0 {
			mappingSection = doc[mapStart : mapStart+mapEnd]
		} else if mapEnd := strings.Index(doc[mapStart:], "---"); mapEnd >= 0 {
			mappingSection = doc[mapStart : mapStart+mapEnd]
		} else {
			mappingSection = doc[mapStart:]
		}
		seen := make(map[string]bool)
		var unknownMapped []string
		for _, m := range mappedActionRe.FindAllStringSubmatch(mappingSection, -1) {
			action := m[1]
			isHTTPRoute := strings.Contains(action, "/") || strings.HasPrefix(action, "GET ") || strings.HasPrefix(action, "POST ")
			if !protoActions[action] && action != "upload" && !isHTTPRoute && !seen[action] {
				unknownMapped = append(unknownMapped, action)
				seen[action] = true
			}
		}
		sort.Strings(unknownMapped)
		if len(unknownMapped) > 0 {
			c.addError("接口总览 § 2.1 映射到不存在的 action：" + strings.Join(unknownMapped, ", "))
		}
	}
}

// ─── 4. SDK 文档校验 ──────────────────────────────────────────────────────────

var (
	sdkMethodRe    = regexp.MustCompile(`(?m)^  (?:async\s+)?([A-Za-z]\w*)(?:<[^>]+>)?\s*\(`)
	sdkDocMethodRe = regexp.MustCompile("^`([A-Za-z]\\w+)(?:\\(\\))?`$")
)

var tsControlKeywords = map[string]bool{
	"catch":  true,
	"for":    true,
	"if":     true,
	"switch": true,
	"while":  true,
}

func (c *checker) checkSDKDoc() {
	client := c.readFile(filepath.Join(c.root, "packages/sdk/src/client.ts"))
	doc := c.readFile(filepath.Join(c.root, "packages/sdk/docs/sdk接口说明.md"))
	if client == "" || doc == "" {
		return
	}

	actual := make(map[string]bool)
	for _, m := range sdkMethodRe.FindAllStringSubmatch(client, -1) {
		if m[1] != "constructor" && !tsControlKeywords[m[1]] {
			actual[m[1]] = true
		}
	}
	c.stats.sdkMethods = len(actual)

	lifecycleStart := strings.Index(doc, "## 2. 生命周期接口")
	eventStart := strings.Index(doc, "## 5. 事件接口")
	if lifecycleStart < 0 || eventStart < 0 {
		c.addError("SDK 接口说明缺少生命周期接口或事件接口章节")
		return
	}
	methodDoc := doc[lifecycleStart:eventStart]

	documented := make(map[string]bool)
	for _, cells := range markdownTableRows(methodDoc) {
		if len(cells) < 2 {
			continue
		}
		m := sdkDocMethodRe.FindStringSubmatch(cells[0])
		if m == nil {
			continue
		}
		if strings.HasPrefix(cells[1], "`(") {
			documented[m[1]] = true
		}
	}

	var missing []string
	for m := range actual {
		if !documented[m] {
			missing = append(missing, m)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		c.addError("SDK 接口说明缺少公开方法：" + strings.Join(missing, ", "))
	}

	var extra []string
	for m := range documented {
		if !actual[m] {
			extra = append(extra, m)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		c.addError("SDK 接口说明包含不存在的公开方法：" + strings.Join(extra, ", "))
	}
}

// ─── 6. 文档相对链接校验 ──────────────────────────────────────────────────────

var markdownLinkRe = regexp.MustCompile(`!?\[[^\]]*\]\(([^)]+)\)`)
var markdownHeadingRe = regexp.MustCompile(`(?m)^(#{1,6})\s+(.+?)\s*$`)

func (c *checker) checkDocLinks() {
	anchorCache := make(map[string]map[string]bool)
	for _, relDir := range []string{"docs", "server/docs", "protocol/docs", "packages/sdk/docs", "packages/uikit/docs"} {
		docsDir := filepath.Join(c.root, relDir)
		err := filepath.WalkDir(docsDir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
				return err
			}
			text := c.readFile(path)
			rel, _ := filepath.Rel(c.root, path)
			for _, m := range markdownLinkRe.FindAllStringSubmatch(text, -1) {
				target := strings.TrimSpace(m[1])
				if target == "" || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "mailto:") {
					continue
				}
				if spaceIdx := strings.Index(target, " "); spaceIdx >= 0 {
					target = target[:spaceIdx]
				}
				anchor := ""
				if hash := strings.Index(target, "#"); hash >= 0 {
					anchor = target[hash+1:]
					target = target[:hash]
				}
				if target == "" {
					continue
				}
				clean := filepath.Clean(filepath.Join(filepath.Dir(path), target))
				if !strings.HasPrefix(clean, c.root) {
					c.addError(fmt.Sprintf("%s 包含越界相对链接：%s", rel, m[1]))
					continue
				}
				if _, err := os.Stat(clean); err != nil {
					c.addError(fmt.Sprintf("%s 包含断链：%s", rel, m[1]))
					continue
				}
				if anchor != "" && strings.HasSuffix(clean, ".md") {
					anchors, ok := anchorCache[clean]
					if !ok {
						anchors = markdownAnchors(c.readFile(clean))
						anchorCache[clean] = anchors
					}
					if !anchors[anchor] {
						c.addError(fmt.Sprintf("%s 包含失效锚点链接：%s", rel, m[1]))
					}
				}
			}
			return nil
		})
		if err != nil {
			c.addError(fmt.Sprintf("遍历文档链接 %s 失败: %v", relDir, err))
		}
	}
}

func markdownAnchors(text string) map[string]bool {
	anchors := make(map[string]bool)
	used := make(map[string]int)
	for _, m := range markdownHeadingRe.FindAllStringSubmatch(text, -1) {
		base := markdownAnchor(m[2])
		if base == "" {
			continue
		}
		anchor := base
		if used[base] > 0 {
			anchor = fmt.Sprintf("%s-%d", base, used[base])
		}
		used[base]++
		anchors[anchor] = true
	}
	return anchors
}

func markdownAnchor(heading string) string {
	heading = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(heading, "`", "")))
	var b strings.Builder
	lastSpace := false
	for _, r := range heading {
		switch {
		case r == ' ' || r == '\t':
			if !lastSpace {
				b.WriteRune('-')
				lastSpace = true
			}
		case r == '-' || r == '_' || r == '/' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= '\u4e00' && r <= '\u9fff':
			if r != '/' {
				b.WriteRune(r)
			}
			lastSpace = false
		default:
			lastSpace = false
		}
	}
	return strings.Trim(b.String(), "-")
}

// ─── 7. 测试统计 ──────────────────────────────────────────────────────────────

var (
	goTestFuncRe = regexp.MustCompile(`(?m)^func\s+(Test\w+)\s*\(`)
	tsTestCallRe = regexp.MustCompile(`\b(?:it|test)\s*\(`)
)

func (c *checker) collectTestStats() {
	c.collectGoTests(filepath.Join(c.root, "server/internal"), &c.stats.goUnitFiles, &c.stats.goUnitTests, nil)
	c.collectGoTests(filepath.Join(c.root, "server/tests/e2e"), &c.stats.goE2EFiles, &c.stats.goE2ETests, &c.stats.goE2EHasMain)
	c.collectFrontendTests(filepath.Join(c.root, "packages/sdk/tests/unit"), &c.stats.frontUnitFiles, &c.stats.frontUnitTests)
	c.collectFrontendTests(filepath.Join(c.root, "packages/uikit/tests/unit"), &c.stats.frontUnitFiles, &c.stats.frontUnitTests)
	c.collectFrontendTests(filepath.Join(c.root, "apps/web/tests/unit"), &c.stats.frontUnitFiles, &c.stats.frontUnitTests)
	c.collectFrontendTests(filepath.Join(c.root, "packages/sdk/tests/integration"), &c.stats.frontSDKFiles, &c.stats.frontSDKTests)
	c.collectFrontendTests(filepath.Join(c.root, "apps/web/tests/ui"), &c.stats.frontUIFiles, &c.stats.frontUITests)
}

func (c *checker) collectGoTests(dir string, files *int, tests *int, hasMain *bool) {
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, "_test.go") {
			return err
		}
		(*files)++
		text := c.readFile(path)
		for _, m := range goTestFuncRe.FindAllStringSubmatch(text, -1) {
			if m[1] == "TestMain" {
				if hasMain != nil {
					*hasMain = true
				}
				continue
			}
			(*tests)++
		}
		return nil
	})
}

func (c *checker) collectFrontendTests(dir string, files *int, tests *int) {
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !(strings.HasSuffix(path, ".test.ts") || strings.HasSuffix(path, ".spec.ts")) {
			return err
		}
		(*files)++
		text := c.readFile(path)
		(*tests) += len(tsTestCallRe.FindAllStringSubmatch(text, -1))
		return nil
	})
}

// ─── 8. 最后复核日期提示 ──────────────────────────────────────────────────────

var reviewDateRe = regexp.MustCompile(`(?m)^> 最后复核：([0-9]{4}-[0-9]{2}-[0-9]{2})。?$`)

func (c *checker) warnReviewDates() {
	changed := c.changedMarkdownFiles()
	today := time.Now().Format("2006-01-02")
	for _, rel := range changed {
		path := filepath.Join(c.root, rel)
		if _, err := os.Stat(path); err != nil {
			if !os.IsNotExist(err) {
				c.warnings = append(c.warnings, fmt.Sprintf("%s 无法读取最后复核日期：%v", rel, err))
			}
			continue
		}
		current := reviewDateRe.FindStringSubmatch(c.readFile(path))
		if current == nil {
			continue
		}
		if current[1] == today {
			continue
		}
		oldText, ok := c.gitShow("HEAD:" + filepath.ToSlash(rel))
		if !ok {
			continue
		}
		old := reviewDateRe.FindStringSubmatch(oldText)
		if old != nil && old[1] == current[1] {
			c.warnings = append(c.warnings, fmt.Sprintf("%s 内容有变动，但最后复核日期仍为 %s", rel, current[1]))
		}
	}
	sort.Strings(c.warnings)
}

func (c *checker) changedMarkdownFiles() []string {
	seen := make(map[string]bool)
	gitDiffArgs := [][]string{
		{"diff", "-z", "--name-only", "HEAD", "--", "docs", "server/docs", "protocol/docs", "packages/sdk/docs", "packages/uikit/docs"},
		{"diff", "-z", "--cached", "--name-only", "HEAD", "--", "docs", "server/docs", "protocol/docs", "packages/sdk/docs", "packages/uikit/docs"},
	}
	for _, args := range gitDiffArgs {
		out, err := exec.Command("git", args...).Output()
		if err != nil {
			continue
		}
		if len(out) == 0 {
			continue
		}
		for _, line := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
			if strings.HasSuffix(line, ".md") {
				seen[line] = true
			}
		}
	}
	items := make([]string, 0, len(seen))
	for item := range seen {
		items = append(items, item)
	}
	sort.Strings(items)
	return items
}

func (c *checker) gitShow(spec string) (string, bool) {
	out, err := exec.Command("git", "show", spec).Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}
