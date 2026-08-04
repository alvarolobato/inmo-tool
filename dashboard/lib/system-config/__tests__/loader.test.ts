/**
 * Tests for lib/system-config/loader.ts
 * Covers: precedence (env > file > default), missing file, corrupt file,
 * write_config (atomic, merge, 0600), importEnvToConfig, bootstrap.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapConfigIfMissing,
  getSystemConfig,
  importEnvToConfig,
  resetConfigCache,
  resetSchemaCache,
  writeConfig,
} from "@/lib/system-config/loader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ps-cfg-test-"));
}

function writeYaml(filePath: string, data: Record<string, unknown>): void {
  const yaml = Object.entries(data)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  fs.writeFileSync(filePath, yaml + "\n", { encoding: "utf-8", mode: 0o600 });
}

/** Minimal schema entry list for tests */
function writeMinimalSchema(
  schemaPath: string,
  extra?: Record<string, unknown>[],
): void {
  const { stringify } = require("yaml") as typeof import("yaml");
  const entries = [
    {
      key: "test.string_key",
      env: "TEST_STRING_KEY",
      type: "string",
      sensitive: false,
      default: "default_val",
      section: "Test",
      description: "A string test key",
      requires_restart: [],
    },
    {
      key: "test.int_key",
      env: "TEST_INT_KEY",
      type: "int",
      sensitive: false,
      default: 42,
      section: "Test",
      description: "An int test key",
      requires_restart: [],
    },
    {
      key: "test.bool_key",
      env: "TEST_BOOL_KEY",
      type: "bool",
      sensitive: false,
      default: false,
      section: "Test",
      description: "A bool test key",
      requires_restart: [],
    },
    {
      key: "test.no_default",
      env: "TEST_NO_DEFAULT_KEY",
      type: "string",
      sensitive: false,
      default: null,
      section: "Test",
      description: "Key with no default",
      requires_restart: [],
    },
    ...(extra ?? []),
  ];

  fs.writeFileSync(schemaPath, stringify(entries), { encoding: "utf-8" });
}

// ---------------------------------------------------------------------------
// Test setup: override CONFIG_SCHEMA_PATH and CONFIG_FILE per test
// ---------------------------------------------------------------------------

let _dir: string;

beforeEach(() => {
  _dir = tmpDir();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  resetSchemaCache();
  vi.unstubAllEnvs();
  fs.rmSync(_dir, { recursive: true, force: true });
});

// Helper: load config with test-local schema + config file
function load(
  schemaFile: string,
  configFile: string,
  extraEnv?: Record<string, string>,
) {
  vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);
  vi.stubEnv("CONFIG_FILE", configFile);
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      vi.stubEnv(k, v);
    }
  }
  return getSystemConfig({ schemaPath: schemaFile, configPath: configFile, noCache: true });
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("getSystemConfig precedence", () => {
  it("env wins over file and default", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    writeYaml(configFile, { "test.string_key": "from_file" });
    vi.stubEnv("TEST_STRING_KEY", "from_env");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.string_key"].value).toBe("from_env");
    expect(cfg["test.string_key"].source).toBe("env");
  });

  it("file wins over default when no env", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    writeYaml(configFile, { "test.string_key": "from_file" });
    vi.stubEnv("TEST_STRING_KEY", "");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.string_key"].value).toBe("from_file");
    expect(cfg["test.string_key"].source).toBe("file");
  });

  it("default used when no env and no file", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "missing_config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.string_key"].value).toBe("default_val");
    expect(cfg["test.string_key"].source).toBe("default");
  });

  it("null when no value anywhere", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "missing.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_NO_DEFAULT_KEY", "");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.no_default"].value).toBeNull();
    expect(cfg["test.no_default"].source).toBe("default");
  });

  it("int coercion from env string", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "missing.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_INT_KEY", "99");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.int_key"].value).toBe(99);
    expect(typeof cfg["test.int_key"].value).toBe("number");
  });

  it("bool coercion from env string", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "missing.yaml");
    writeMinimalSchema(schemaFile);

    for (const truthy of ["true", "True", "1", "yes", "on"]) {
      vi.stubEnv("TEST_BOOL_KEY", truthy);
      const cfg = load(schemaFile, configFile);
      expect(cfg["test.bool_key"].value).toBe(true);
    }
  });

  it("missing config file returns defaults", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "absent.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    const cfg = load(schemaFile, configFile);
    expect(cfg["test.string_key"].source).toBe("default");
    expect(cfg["test.string_key"].value).toBe("default_val");
  });

  it("throws on corrupt config file (not a mapping)", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    fs.writeFileSync(configFile, "- item1\n- item2\n", { encoding: "utf-8" });

    expect(() => load(schemaFile, configFile)).toThrow(/mapping/);
  });

  it("throws on invalid int value (parity with Python loader)", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_INT_KEY", "not-a-number");

    expect(() => load(schemaFile, configFile)).toThrow(/expected int/i);
  });
});

// ---------------------------------------------------------------------------
// writeConfig
// ---------------------------------------------------------------------------

describe("writeConfig", () => {
  it("creates file with 0600 permissions", () => {
    const configFile = path.join(_dir, "config.yaml");
    writeConfig({ "my.key": "hello" }, { configPath: configFile });
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("written file is valid YAML and readable", () => {
    const configFile = path.join(_dir, "config.yaml");
    writeConfig({ "a.key": "value1", "b.key": 123 }, { configPath: configFile });
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("a.key");
    expect(content).toContain("value1");
  });

  it("merges with existing keys", () => {
    const configFile = path.join(_dir, "config.yaml");
    writeConfig({ "existing.key": "old" }, { configPath: configFile });
    writeConfig({ "new.key": "new_value" }, { configPath: configFile });
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("existing.key");
    expect(content).toContain("new.key");
  });

  it("overwrites existing key", () => {
    const configFile = path.join(_dir, "config.yaml");
    writeConfig({ "k": "old" }, { configPath: configFile });
    writeConfig({ "k": "new" }, { configPath: configFile });
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("new");
    expect(content).not.toMatch(/old/); // "old" should be gone
  });

  it("creates parent directories", () => {
    const configFile = path.join(_dir, "deep", "nested", "config.yaml");
    writeConfig({ "k": "v" }, { configPath: configFile });
    expect(fs.existsSync(configFile)).toBe(true);
  });

  it("invalidates cache after write", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    load(schemaFile, configFile); // primes cache
    writeConfig({ "test.string_key": "new_val" }, { configPath: configFile });
    const cfg2 = load(schemaFile, configFile);
    expect(cfg2["test.string_key"].value).toBe("new_val");
    expect(cfg2["test.string_key"].source).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// importEnvToConfig
// ---------------------------------------------------------------------------

describe("importEnvToConfig", () => {
  it("imports env-sourced keys to file", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "from_env_import");
    vi.stubEnv("TEST_INT_KEY", "");

    const imported = importEnvToConfig({ configPath: configFile });
    expect(imported).toContain("test.string_key");
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("from_env_import");
  });

  it("does not import default-only keys", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    const imported = importEnvToConfig({ configPath: configFile });
    expect(imported).not.toContain("test.string_key");
  });
});

// ---------------------------------------------------------------------------
// bootstrapConfigIfMissing
// ---------------------------------------------------------------------------

describe("bootstrapConfigIfMissing", () => {
  it("creates file when absent", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);

    const created = bootstrapConfigIfMissing({ configPath: configFile });
    expect(created).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);
  });

  it("noop if file already exists", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    writeConfig({ "existing": "value" }, { configPath: configFile });

    const created = bootstrapConfigIfMissing({ configPath: configFile });
    expect(created).toBe(false);
  });

  it("bootstrapped file has 0600 permissions", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);

    bootstrapConfigIfMissing({ configPath: configFile });
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("bootstrapped file contains default values", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    bootstrapConfigIfMissing({ configPath: configFile });
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("default_val");
  });

  it("bootstrapped file contains env values when set", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("CONFIG_SCHEMA_PATH", schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "env_bootstrap_val");

    bootstrapConfigIfMissing({ configPath: configFile });
    const content = fs.readFileSync(configFile, "utf-8");
    expect(content).toContain("env_bootstrap_val");
  });
});

// ---------------------------------------------------------------------------
// Integration: verify writeConfig and getSystemConfig work end-to-end
// ---------------------------------------------------------------------------

describe("end-to-end write + read", () => {
  it("written value is reflected on next load", () => {
    const schemaFile = path.join(_dir, "schema.yaml");
    const configFile = path.join(_dir, "e2e-config.yaml");
    writeMinimalSchema(schemaFile);
    vi.stubEnv("TEST_STRING_KEY", "");

    writeConfig({ "test.string_key": "written_value" }, { configPath: configFile });
    const cfg = load(schemaFile, configFile);
    expect(cfg["test.string_key"].value).toBe("written_value");
    expect(cfg["test.string_key"].source).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// Canonical schema — per-flow OpenRouter model keys must match the real
// DashboardLlmFlow enum, and the PowerShop-leftover keys must not reappear.
// This loads the ACTUAL repo-root config/schema.yaml (the single canonical
// source that dev, tests, and Docker all resolve to) — not a synthetic one.
// ---------------------------------------------------------------------------

describe("canonical config/schema.yaml — flow keys", () => {
  // Repo-root config/schema.yaml relative to this test file:
  // __tests__ → system-config → lib → dashboard → repo root.
  const canonicalSchema = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "config",
    "schema.yaml",
  );

  // Must match `DashboardLlmFlow` in dashboard/lib/llm-provider/types.ts, which
  // is exactly what dashboard/lib/llm-provider/config.ts reads into
  // openrouterModelByFlow.
  const REAL_FLOWS = ["occupancy", "condition", "redflags", "extract", "compare", "chat"];
  const STALE_FLOWS = ["generate", "modify", "analyze", "weekly"];

  function loadCanonical() {
    const missingConfig = path.join(_dir, "no-such-config.yaml");
    return getSystemConfig({
      schemaPath: canonicalSchema,
      configPath: missingConfig,
      noCache: true,
    });
  }

  it("exposes a per-flow OpenRouter model key for every real DashboardLlmFlow", () => {
    const cfg = loadCanonical();
    for (const flow of REAL_FLOWS) {
      const key = `dashboard.llm_model_openrouter_${flow}`;
      expect(cfg[key], `missing canonical schema key ${key}`).toBeDefined();
      expect(cfg[key].env).toBe(`DASHBOARD_LLM_MODEL_OPENROUTER_${flow.toUpperCase()}`);
    }
  });

  it("does NOT contain the stale PowerShop-leftover flow keys", () => {
    const cfg = loadCanonical();
    for (const flow of STALE_FLOWS) {
      const key = `dashboard.llm_model_openrouter_${flow}`;
      expect(cfg[key], `stale schema key ${key} must not exist`).toBeUndefined();
    }
  });

  it("preserves the complete key set (postgres/etl/infra/dashboard) with correct types", () => {
    const cfg = loadCanonical();
    // A representative key from each section survives the reconciliation.
    for (const key of [
      "postgres.user",
      "postgres.dsn",
      "etl.dashboard_base_url",
      "infra.host_bind",
      "dashboard.llm_provider",
      "dashboard.llm_model_openrouter",
    ]) {
      expect(cfg[key], `missing canonical schema key ${key}`).toBeDefined();
    }
    // query_cost_limit is an integer threshold — the canonical type is int.
    expect(cfg["dashboard.query_cost_limit"].type).toBe("int");
  });
});
