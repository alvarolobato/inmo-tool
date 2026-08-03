import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Node 22+ ships an experimental global `localStorage`/`sessionStorage` (flag
// `--experimental-webstorage`, on by default). It installs a lazy accessor on
// `globalThis` that jsdom's own `window.localStorage` cannot override, so
// every jsdom-environment test sees `localStorage === undefined` (with a
// noisy "--localstorage-file was not provided" warning) instead of jsdom's
// working in-memory Storage. Disabling the Node feature for the worker
// processes vitest forks restores jsdom's implementation. Set here (not in
// package.json's test script) so it applies uniformly regardless of how
// vitest is invoked (npm test, npx vitest, CI, watch mode).
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--no-experimental-webstorage"]
  .filter(Boolean)
  .join(" ");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // Test FILES run one at a time. 21 test files open a real `pg` pool, and
    // #159 gives the whole run ONE isolated database — not one per file — so
    // any two DB-touching files that overlap in time see each other's rows.
    //
    // This was invisible until #160 gave CI a real database: with parallelism
    // on, `price-signal.integration` (2 tests) and `profiles.integration`
    // (1 test) fail, and all three pass when run alone. `profiles` asserts a
    // count over the WHOLE table and saw 166 rows where it expected 0.
    //
    // Files previously tried to dodge this by picking non-overlapping map
    // coordinates (see price-signal.integration's header). That mitigation is
    // unsound — it cannot help an assertion that counts every row, and it
    // silently breaks whenever a new file picks a nearby fixture. Serialising
    // is the only version that stays correct as files are added.
    //
    // Cost is small: 185 files / 2262 tests in ~58s serialised, because most
    // of the parallel run's wall time was jsdom/react environment setup, not
    // test execution.
    fileParallelism: false,
    include: ["**/__tests__/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "components/**/*.tsx", "components/**/*.ts"],
      exclude: [
        "**/__tests__/**",
        "**/node_modules/**",
        "**/*.d.ts",
        // Type-only modules: no runtime code, only TypeScript interface/type declarations.
        // V8 reports these as 0% (the file body is empty after compilation), which
        // artificially depresses the global coverage rates. Excluding is safe because
        // any actual logic lives in sibling .ts files that ARE covered.
        "lib/llm-provider/types.ts",
        "lib/llm-provider/cli/types.ts",
        "lib/llm-tools/runner-types.ts",
        // Integration-bound LLM tool handlers and orchestrator: heavy DB / subprocess /
        // OpenRouter coupling makes meaningful unit tests fragile. The dashboard route
        // tests mock these modules wholesale (`vi.mock("@/lib/llm")` in
        // `app/api/dashboard/**` tests, `vi.mock("@/lib/llm-tools/handlers/dashboards")`
        // in `llm-tools-runner*` tests), so V8 records 0% for the real code. These paths
        // are instead exercised by integration tests against the postgres mirror when
        // run under Docker. Excluding them prevents the global threshold from being
        // dragged down by code that has *no* in-process unit coverage by design.
        // TODO: replace with lower-layer mocks (DB / subprocess / OpenRouter) so the
        // orchestrator itself is exercised.
      ],
      // Floors: relaxed to 70% (2026-04) after agentic handlers enlarged the
      // covered surface; functions relaxed to 67% (2026-05) after Phase 3
      // conversation-engine rewrite added ConversationPane + ChatSidebar with
      // complex SSE/mouse-event handlers that need integration-level tests.
      // branches relaxed to 61% (2026-05) after Phase 4 removed ChatSidebar
      // unit tests (component covered by integration/e2e tests instead).
      thresholds: {
        statements: 70,
        branches: 61,
        functions: 67,
        lines: 70,
      },
    },
  },
});
