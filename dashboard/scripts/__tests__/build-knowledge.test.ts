/**
 * Tests for dashboard/scripts/build-knowledge.ts.
 *
 * `build-knowledge.ts` is live, generic machinery (`npm run build:knowledge`)
 * that compiles `## LLM:*` marker sections from the source MDs listed in
 * `docs/knowledge-sources.yml` into `dashboard/lib/knowledge.ts`. It is NOT
 * dead code — see `dashboard/lib/__tests__/knowledge.test.ts` for the
 * consumer side (`lib/llm-context/system-prompt.ts`, `formatters.ts`).
 *
 * The original version of this file (pre-#158) asserted PowerShop-specific
 * content: a `docs/data-decisions.md` source, "no activa or anulada field"
 * text, and "exactly 12 sources" in the manifest. None of that exists in
 * this product — task 1.1 (#9) deleted the whole PowerShop corpus and
 * `docs/knowledge-sources.yml` is deliberately `sources: []` pending Phase 4
 * (#5) real-estate corpus authoring. Rewritten (issue #158) to test the
 * mechanism itself with fixture content, independent of what corpus (if
 * any) currently exists — plus one test documenting today's actual manifest
 * state, analogous to knowledge.test.ts's "current corpus state" block.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseMarkdownSections,
  extractJsonArray,
  extractSqlPairs,
  emitInstructions,
  emitSqlPairs,
  emitSchema,
  emitRelationships,
  type Instruction,
  type SqlPair,
  type TableSchema,
  type Relationship,
} from "../build-knowledge";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const KNOWLEDGE_TS = path.join(REPO_ROOT, "dashboard", "lib", "knowledge.ts");
const MANIFEST = path.join(REPO_ROOT, "docs", "knowledge-sources.yml");

describe("build-knowledge: marker-section parsing", () => {
  it("extracts a single ## LLM:<marker> section up to the next ## heading", () => {
    const md = `# Some doc

Intro text, not part of any section.

## LLM:rules

[{"instruction": "example", "questions": ["q1"]}]

## Not an LLM section

This should not be included.
`;
    const sections = parseMarkdownSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].marker).toBe("rules");
    expect(sections[0].content).toContain('"instruction": "example"');
    expect(sections[0].content).not.toContain("Not an LLM section");
  });

  it("extracts multiple marker sections from one file", () => {
    const md = `## LLM:tables

[{"table": "property", "alias": "p", "description": "d", "keyColumns": ["id"]}]

## LLM:relationships

[{"from": "listing", "fromColumn": "property_id", "to": "property", "toColumn": "id", "type": "MANY_TO_ONE"}]
`;
    const sections = parseMarkdownSections(md);
    expect(sections.map((s) => s.marker)).toEqual(["tables", "relationships"]);
  });

  it("returns no sections when the file has no ## LLM: markers", () => {
    const md = `# A doc\n\nJust prose, no markers.\n`;
    expect(parseMarkdownSections(md)).toEqual([]);
  });
});

describe("build-knowledge: JSON array extraction", () => {
  it("parses a fenced JSON array", () => {
    const content = '```json\n[{"a": 1}, {"a": 2}]\n```';
    const result = extractJsonArray<{ a: number }>(content, "rules", "fixture.md");
    expect(result).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses a bare (unfenced) JSON array", () => {
    const content = '[{"a": 1}]';
    const result = extractJsonArray<{ a: number }>(content, "rules", "fixture.md");
    expect(result).toEqual([{ a: 1 }]);
  });

  it("wraps a bare JSON object as a single-element array", () => {
    const content = '{"a": 1}';
    const result = extractJsonArray<{ a: number }>(content, "rules", "fixture.md");
    expect(result).toEqual([{ a: 1 }]);
  });

  it("returns [] and warns (does not throw) on invalid JSON", () => {
    const content = "```json\nnot valid json\n```";
    expect(() =>
      extractJsonArray(content, "rules", "fixture.md")
    ).not.toThrow();
    expect(extractJsonArray(content, "rules", "fixture.md")).toEqual([]);
  });
});

describe("build-knowledge: SQL pair extraction", () => {
  it("extracts question/SQL pairs from ### heading + ```sql``` blocks", () => {
    const content = `### how many active listings are there?
\`\`\`sql
SELECT count(*) FROM listing WHERE status = 'active'
\`\`\`

### what is the average price per property type?
\`\`\`sql
SELECT property_type, avg(price) FROM listing GROUP BY property_type
\`\`\`
`;
    const pairs = extractSqlPairs(content, "fixture.md");
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({
      question: "how many active listings are there?",
      sql: "SELECT count(*) FROM listing WHERE status = 'active'",
    });
    expect(pairs[1].question).toBe(
      "what is the average price per property type?"
    );
  });

  it("skips a question heading with no following SQL fence", () => {
    const content = `### a question with no SQL block\n\nJust prose.\n`;
    expect(extractSqlPairs(content, "fixture.md")).toEqual([]);
  });
});

describe("build-knowledge: TS emitters round-trip through the real types", () => {
  it("emitInstructions/emitSqlPairs/emitSchema/emitRelationships produce parseable TS array bodies", () => {
    const instructions: Instruction[] = [
      { instruction: "Always filter soft-deleted rows.", questions: ["q1", "q2"] },
    ];
    const sqlPairs: SqlPair[] = [
      { question: "active listings?", sql: "SELECT * FROM listing WHERE status = 'active'" },
    ];
    const schema: TableSchema[] = [
      { table: "property", alias: "p", description: "A property", keyColumns: ["id"] },
    ];
    const relationships: Relationship[] = [
      { from: "listing", fromColumn: "property_id", to: "property", toColumn: "id", type: "MANY_TO_ONE" },
    ];

    const body = `
      export const I = [${emitInstructions(instructions)}];
      export const S = [${emitSqlPairs(sqlPairs)}];
      export const T = [${emitSchema(schema)}];
      export const R = [${emitRelationships(relationships)}];
      I; S; T; R;
    `;
    // A syntax check without a real TS compiler: Function() will throw on
    // malformed JS. Backticks/${} in emitted SQL are escaped by emitSqlPairs
    // (jsStr), so this is also a regression check for that escaping.
    expect(() => new Function(body.replace(/export const/g, "const"))).not.toThrow();

    expect(emitInstructions(instructions)).toContain("Always filter soft-deleted rows.");
    expect(emitRelationships(relationships)).toContain('"MANY_TO_ONE"');
  });

  it("emitSqlPairs escapes backticks and ${} in SQL so the emitted template literal is valid", () => {
    const pairs: SqlPair[] = [
      { question: "weird sql", sql: "SELECT `col` , 'lit ${not_interpolated}'" },
    ];
    const emitted = emitSqlPairs(pairs);
    expect(emitted).toContain("\\`col\\`");
    expect(emitted).toContain("\\${not_interpolated}");
  });
});

describe("build-knowledge: current repo state", () => {
  it("dashboard/lib/knowledge.ts exists and matches the empty-corpus shape", () => {
    expect(fs.existsSync(KNOWLEDGE_TS)).toBe(true);
    const content = fs.readFileSync(KNOWLEDGE_TS, "utf8");
    expect(content).toContain("export const INSTRUCTIONS: Instruction[] = [");
    expect(content).toContain("export const SQL_PAIRS: SqlPair[] = [");
    expect(content).toContain("export const SCHEMA: TableSchema[] = [");
    expect(content).toContain("export const RELATIONSHIPS: Relationship[] = [");
  });

  it("knowledge-sources.yml is a valid manifest and every listed path exists", () => {
    const { parse } = require("yaml");
    const raw = fs.readFileSync(MANIFEST, "utf8");
    const data = parse(raw) as { sources: Array<{ path: string; slice: string }> };
    expect(Array.isArray(data.sources)).toBe(true);
    for (const source of data.sources) {
      const abs = path.join(REPO_ROOT, source.path);
      expect(fs.existsSync(abs), `${source.path} should exist`).toBe(true);
    }
  });

  it("knowledge-sources.yml has no sources yet, pending Phase 4 (#5) — update when that lands", () => {
    const { parse } = require("yaml");
    const raw = fs.readFileSync(MANIFEST, "utf8");
    const data = parse(raw) as { sources: unknown[] };
    expect(data.sources).toEqual([]);
  });
});
