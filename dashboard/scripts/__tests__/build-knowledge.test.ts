/**
 * Tests for dashboard/scripts/build-knowledge.ts (EC-7).
 *
 * Verifies that docs/data-decisions.md content appears in the generated
 * knowledge.ts (the bug this phase fixes: data-decisions was missing from
 * the dashboard LLM bundle despite being in the action's SLICE_MAP).
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const KNOWLEDGE_TS = path.join(REPO_ROOT, "dashboard", "lib", "knowledge.ts");
const MANIFEST = path.join(REPO_ROOT, "docs", "knowledge-sources.yml");

describe("build-knowledge", () => {
  it("knowledge.ts exists and is non-empty", () => {
    expect(fs.existsSync(KNOWLEDGE_TS)).toBe(true);
    const content = fs.readFileSync(KNOWLEDGE_TS, "utf8");
    expect(content.length).toBeGreaterThan(1000);
  });

  it("knowledge.ts sources header includes docs/data-decisions.md (EC-7)", () => {
    const content = fs.readFileSync(KNOWLEDGE_TS, "utf8");
    // The build script emits "//   docs/data-decisions.md" in the sources header
    expect(content).toContain("docs/data-decisions.md");
  });

  it("knowledge.ts INSTRUCTIONS include content from docs/data-decisions.md (EC-7)", () => {
    const content = fs.readFileSync(KNOWLEDGE_TS, "utf8");
    // "no activa or anulada field" appears only in data-decisions.md's LLM:rules JSON.
    // Other source MDs do not contain this exact phrase, so its presence in INSTRUCTIONS
    // proves data-decisions.md actually contributed to knowledge.ts (not just other sources).
    expect(content).toContain("no activa or anulada field");
  });

  it("knowledge-sources.yml lists exactly 12 sources and all paths exist", () => {
    const { parse } = require("yaml");
    const raw = fs.readFileSync(MANIFEST, "utf8");
    const data = parse(raw) as { sources: Array<{ path: string; slice: string }> };
    expect(data.sources).toHaveLength(12);
    for (const source of data.sources) {
      const abs = path.join(REPO_ROOT, source.path);
      expect(fs.existsSync(abs), `${source.path} should exist`).toBe(true);
    }
  });

  it("knowledge-sources.yml includes data-decisions slice", () => {
    const { parse } = require("yaml");
    const raw = fs.readFileSync(MANIFEST, "utf8");
    const data = parse(raw) as { sources: Array<{ slice: string; path: string }> };
    const dataDec = data.sources.find((s) => s.slice === "data-decisions");
    expect(dataDec).toBeDefined();
    expect(dataDec!.path).toBe("docs/data-decisions.md");
  });
});
