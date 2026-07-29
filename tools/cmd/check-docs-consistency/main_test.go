package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClassifyTestPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want testCategory
	}{
		{name: "server internal is Go non E2E", path: "server/internal/auth/auth_test.go", want: testCategoryGoNonE2E},
		{name: "server command is Go non E2E", path: "server/cmd/yimsg-server/options_test.go", want: testCategoryGoNonE2E},
		{name: "CLI unit is Go non E2E", path: "cli/store/store_test.go", want: testCategoryGoNonE2E},
		{name: "Agent unit is Go non E2E", path: "agent/engine/engine_test.go", want: testCategoryGoNonE2E},
		{name: "tool unit is Go non E2E", path: "tools/cmd/package-release/main_test.go", want: testCategoryGoNonE2E},
		{name: "Server E2E", path: "server/tests/e2e/auth_test.go", want: testCategoryServerE2E},
		{name: "nested Server E2E", path: "server/tests/e2e/protocol/frame_test.go", want: testCategoryServerE2E},
		{name: "CLI E2E", path: "cli/tests/e2e/cli_test.go", want: testCategoryCLIE2E},
		{name: "Agent E2E with Windows separators", path: `agent\tests\e2e\agent_test.go`, want: testCategoryAgentE2E},
		{name: "other E2E excluded from Go non E2E", path: "plugin/tests/e2e/plugin_test.go", want: testCategoryIgnored},
		{name: "similar E2E directory name is not excluded", path: "server/tests/e2eish/helper_test.go", want: testCategoryGoNonE2E},
		{name: "non test Go file ignored", path: "server/internal/auth/auth.go", want: testCategoryIgnored},
		{name: "SDK unit", path: "packages/sdk/tests/unit/sdk/client.test.ts", want: testCategorySDKUnit},
		{name: "UIKit unit", path: "packages/uikit/tests/unit/bounded-list/page-window.test.ts", want: testCategoryUIKitUnit},
		{name: "Web unit", path: "apps/web/tests/unit/home-dashboard.test.ts", want: testCategoryWebUnit},
		{name: "SDK integration", path: "packages/sdk/tests/integration/sdk.test.ts", want: testCategorySDKIntegration},
		{name: "Web E2E", path: "apps/web/tests/e2e/auth.spec.ts", want: testCategoryWebE2E},
		{name: "Web component", path: "apps/web/tests/component/bounded-list.spec.ts", want: testCategoryWebComponent},
		{name: "Web performance", path: "apps/web/tests/performance/bounded-list.performance.spec.ts", want: testCategoryWebPerformance},
		{name: "TSX test supported", path: "apps/web/tests/component/widget.spec.tsx", want: testCategoryWebComponent},
		{name: "support spec excluded", path: "apps/web/tests/support/accidental.spec.ts", want: testCategoryIgnored},
		{name: "support helper excluded", path: "apps/web/tests/support/test-fixtures.ts", want: testCategoryIgnored},
		{name: "old UI directory not silently merged", path: "apps/web/tests/ui/legacy.spec.ts", want: testCategoryIgnored},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyTestPath(tc.path); got != tc.want {
				t.Fatalf("classifyTestPath(%q) = %d, want %d", tc.path, got, tc.want)
			}
		})
	}
}

func TestShouldSkipTestStatsDir(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: ".", want: false},
		{path: "packages/sdk", want: false},
		{path: "node_modules", want: true},
		{path: "packages/sdk/node_modules", want: true},
		{path: `packages\sdk\vendor`, want: true},
		{path: ".tmp", want: true},
		{path: "packages/sdk/.tmp", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			if got := shouldSkipTestStatsDir(tc.path); got != tc.want {
				t.Fatalf("shouldSkipTestStatsDir(%q) = %t, want %t", tc.path, got, tc.want)
			}
		})
	}
}

func TestCollectTestStatsUsesDeclaredCategories(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"server/internal/auth/auth_test.go": `package auth
func TestAuth() {}
`,
		"tools/cmd/example/main_test.go": `package main
func TestMain() {}
func TestTool() {}
`,
		"server/tests/e2e/setup_test.go": `package e2e
func TestMain() {}
func TestServerE2E() {}
`,
		"cli/tests/e2e/cli_test.go": `package e2e
func TestCLIE2E() {}
`,
		"agent/tests/e2e/nested/agent_test.go": `package e2e
func TestAgentE2E() {}
`,
		"plugin/tests/e2e/plugin_test.go": `package e2e
func TestMustStayExcluded() {}
`,
		"packages/sdk/tests/unit/sdk/client.test.ts": `test("sdk", () => {})
`,
		"packages/uikit/tests/unit/widget.test.ts": `it("uikit", () => {})
`,
		"apps/web/tests/unit/home.test.ts": `test("web unit", () => {})
`,
		"packages/sdk/tests/integration/sdk.test.ts": `test("sdk integration", () => {})
`,
		"apps/web/tests/e2e/auth.spec.ts": `test.describe("auth", () => {})
test("web e2e", () => {})
`,
		"apps/web/tests/component/widget.spec.ts": `test("component", () => {})
`,
		"apps/web/tests/performance/widget.spec.ts": `test("performance", () => {})
`,
		"apps/web/tests/support/accidental.spec.ts": `test("support is not a spec", () => {})
`,
		"node_modules/dependency/dependency_test.go": `package dependency
func TestDependency() {}
`,
	}
	for path, content := range files {
		writeTestFixture(t, root, path, content)
	}

	c := &checker{root: root}
	c.collectTestStats()
	if len(c.errors) > 0 {
		t.Fatalf("collectTestStats errors: %v", c.errors)
	}

	assertTestStats(t, "Go non E2E", c.stats.goNonE2E, testStats{files: 2, declarations: 2, hasTestMain: true})
	assertTestStats(t, "Server E2E", c.stats.serverE2E, testStats{files: 1, declarations: 1, hasTestMain: true})
	assertTestStats(t, "CLI E2E", c.stats.cliE2E, testStats{files: 1, declarations: 1})
	assertTestStats(t, "Agent E2E", c.stats.agentE2E, testStats{files: 1, declarations: 1})
	assertTestStats(t, "SDK unit", c.stats.sdkUnit, testStats{files: 1, declarations: 1})
	assertTestStats(t, "UIKit unit", c.stats.uikitUnit, testStats{files: 1, declarations: 1})
	assertTestStats(t, "Web unit", c.stats.webUnit, testStats{files: 1, declarations: 1})
	assertTestStats(t, "SDK integration", c.stats.sdkIntegration, testStats{files: 1, declarations: 1})
	assertTestStats(t, "Web E2E", c.stats.webE2E, testStats{files: 1, declarations: 1})
	assertTestStats(t, "Web component", c.stats.webComponent, testStats{files: 1, declarations: 1})
	assertTestStats(t, "Web performance", c.stats.webPerformance, testStats{files: 1, declarations: 1})
}

func writeTestFixture(t *testing.T, root, path, content string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("create fixture directory %s: %v", path, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write fixture %s: %v", path, err)
	}
}

func assertTestStats(t *testing.T, label string, got, want testStats) {
	t.Helper()
	if got != want {
		t.Fatalf("%s stats = %+v, want %+v", label, got, want)
	}
}
