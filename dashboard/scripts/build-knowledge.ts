#!/usr/bin/env tsx
// Build script — run with: npm run build:knowledge
// Compiles LLM:* marker sections from source MDs into dashboard/lib/knowledge.ts.

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

// ─── Source MD list (loaded from docs/knowledge-sources.yml) ─────────────────

const REPO_ROOT = path.resolve(__dirname, "../..");

interface KnowledgeSource {
  slice: string;
  path: string;
  markers: string[];
}

function loadSourceMDs(): string[] {
  const manifestPath = path.join(REPO_ROOT, "docs", "knowledge-sources.yml");
  const content = fs.readFileSync(manifestPath, "utf8");
  const data = parseYaml(content) as { sources: KnowledgeSource[] };
  return data.sources.map((s) => s.path);
}

const SOURCE_MDS: string[] = loadSourceMDs();

const OUTPUT_FILE = path.resolve(__dirname, "../lib/knowledge.ts");

// ─── Types (mirrors dashboard/lib/knowledge.ts) ───────────────────────────────

interface Instruction {
  instruction: string;
  questions: string[];
}

interface SqlPair {
  question: string;
  sql: string;
}

interface TableSchema {
  table: string;
  alias: string;
  description: string;
  keyColumns: string[];
}

// All current WrenAI relationships are MANY_TO_ONE; type is kept as string
// (not a union literal) so future ONE_TO_ONE or MANY_TO_MANY entries in source
// MDs emit correctly without requiring interface changes.
interface Relationship {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  type: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const LLM_HEADING = /^## LLM:(\w[\w-]*)$/;
// Any ## heading (including non-LLM) terminates the current LLM section.
const ANY_H2 = /^## /;

interface ParsedSection {
  marker: string;
  content: string;
}

function parseMarkdownSections(source: string): ParsedSection[] {
  const lines = source.split("\n");
  const sections: ParsedSection[] = [];
  let currentMarker: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const m = LLM_HEADING.exec(line.trimEnd());
    if (m) {
      if (currentMarker !== null) {
        sections.push({ marker: currentMarker, content: currentLines.join("\n").trim() });
      }
      currentMarker = m[1];
      currentLines = [];
    } else if (currentMarker !== null) {
      if (ANY_H2.test(line)) {
        sections.push({ marker: currentMarker, content: currentLines.join("\n").trim() });
        currentMarker = null;
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
  }

  if (currentMarker !== null) {
    sections.push({ marker: currentMarker, content: currentLines.join("\n").trim() });
  }

  return sections;
}

// ─── Section content extractors ───────────────────────────────────────────────

function extractJsonArray<T>(content: string, marker: string, filePath: string): T[] {
  // Find first JSON code block in the section content
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/;
  const m = fenceRe.exec(content);
  if (!m) {
    // No code block — try bare JSON
    const trimmed = content.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        console.warn(`  [warn] ${filePath}: ## LLM:${marker} — invalid JSON, skipping`);
        return [];
      }
    }
    return [];
  }
  try {
    const parsed = JSON.parse(m[1].trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.warn(`  [warn] ${filePath}: ## LLM:${marker} — JSON parse error: ${e}, skipping`);
    return [];
  }
}

function extractSqlPairs(content: string, filePath: string): SqlPair[] {
  const pairs: SqlPair[] = [];
  // Each pair: ### <question text>\n```sql\n<SQL>\n```
  const entryRe = /^### (.+)$/gm;
  const sqlFenceRe = /```(?:sql)?\s*\n([\s\S]*?)```/g;

  // Collect all ### headings and their positions
  const questions: Array<{ question: string; idx: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(content)) !== null) {
    questions.push({ question: match[1].trim(), idx: match.index });
  }

  for (let i = 0; i < questions.length; i++) {
    const start = questions[i].idx;
    const end = i + 1 < questions.length ? questions[i + 1].idx : content.length;
    const block = content.slice(start, end);

    sqlFenceRe.lastIndex = 0;
    const sqlMatch = sqlFenceRe.exec(block);
    if (!sqlMatch) {
      console.warn(`  [warn] ${filePath}: ## LLM:sql-pairs — no SQL block for question "${questions[i].question}", skipping`);
      continue;
    }
    pairs.push({ question: questions[i].question, sql: sqlMatch[1].trim() });
  }

  return pairs;
}

// ─── TS code emitters ─────────────────────────────────────────────────────────

function jsStr(s: string): string {
  // Escape backticks and backslashes for template literal
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function emitInstructions(instructions: Instruction[]): string {
  return instructions
    .map((inst) => {
      const qs = inst.questions.map((q) => `      ${JSON.stringify(q)}`).join(",\n");
      return `  {\n    instruction:\n      ${JSON.stringify(inst.instruction)},\n    questions: [\n${qs},\n    ],\n  }`;
    })
    .join(",\n");
}

function emitSqlPairs(pairs: SqlPair[]): string {
  return pairs
    .map((pair) => {
      return `  {\n    question: ${JSON.stringify(pair.question)},\n    sql: \`${jsStr(pair.sql)}\`,\n  }`;
    })
    .join(",\n");
}

function emitSchema(tables: TableSchema[]): string {
  return tables
    .map((t) => {
      const cols = t.keyColumns.map((c) => `      ${JSON.stringify(c)}`).join(",\n");
      return `  {\n    table: ${JSON.stringify(t.table)},\n    alias: ${JSON.stringify(t.alias)},\n    description:\n      ${JSON.stringify(t.description)},\n    keyColumns: [\n${cols},\n    ],\n  }`;
    })
    .join(",\n");
}

function emitRelationships(rels: Relationship[]): string {
  return rels
    .map(
      (r) =>
        `  { from: ${JSON.stringify(r.from)}, fromColumn: ${JSON.stringify(r.fromColumn)}, to: ${JSON.stringify(r.to)}, toColumn: ${JSON.stringify(r.toColumn)}, type: ${JSON.stringify(r.type)} }`
    )
    .join(",\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: tsx scripts/build-knowledge.ts [--dry-run]");
    console.log("");
    console.log("Reads ## LLM:* marker sections from source Markdown files and");
    console.log("compiles them into dashboard/lib/knowledge.ts.");
    console.log("");
    console.log("Options:");
    console.log("  --dry-run   Parse sources and report counts without writing output file.");
    console.log("  --help      Show this help message.");
    console.log("");
    console.log("Source MDs:");
    for (const rel of SOURCE_MDS) console.log(`  ${rel}`);
    return;
  }
  const isDryRun = process.argv.includes("--dry-run");

  const instructions: Instruction[] = [];
  const sqlPairs: SqlPair[] = [];
  const schema: TableSchema[] = [];
  const relationships: Relationship[] = [];

  const foundFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const rel of SOURCE_MDS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[warn] source MD not found, skipping: ${rel}`);
      skippedFiles.push(rel);
      continue;
    }
    foundFiles.push(rel);
    const source = fs.readFileSync(abs, "utf8");
    const sections = parseMarkdownSections(source);

    for (const sec of sections) {
      switch (sec.marker) {
        case "tables":
          schema.push(...extractJsonArray<TableSchema>(sec.content, "tables", rel));
          break;
        case "relationships":
          relationships.push(...extractJsonArray<Relationship>(sec.content, "relationships", rel));
          break;
        case "rules":
          instructions.push(...extractJsonArray<Instruction>(sec.content, "rules", rel));
          break;
        case "sql-pairs":
          sqlPairs.push(...extractSqlPairs(sec.content, rel));
          break;
        default:
          console.warn(`[warn] ${rel}: unknown LLM marker ## LLM:${sec.marker}, ignoring`);
      }
    }
  }

  if (isDryRun) {
    console.log("\n=== DRY RUN ===");
    console.log(`Found ${foundFiles.length} source MDs:`);
    for (const f of foundFiles) console.log(`  ✓  ${f}`);
    if (skippedFiles.length) {
      console.log(`Skipped ${skippedFiles.length} missing MDs:`);
      for (const f of skippedFiles) console.log(`  ✗  ${f}`);
    }
    console.log(`\nExtracted:`);
    console.log(`  SCHEMA:        ${schema.length} tables`);
    console.log(`  RELATIONSHIPS: ${relationships.length}`);
    console.log(`  INSTRUCTIONS:  ${instructions.length}`);
    console.log(`  SQL_PAIRS:     ${sqlPairs.length}`);
    console.log("\nOutput would be written to:", OUTPUT_FILE);
    return;
  }

  // Emit knowledge.ts
  const ts = `// Auto-generated. Edit the source MDs and run npm run build:knowledge.
// DO NOT edit this file by hand — changes will be overwritten on next build.
//
// Sources:
${foundFiles.map((f) => `//   ${f}`).join("\n")}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Instruction {
  instruction: string;
  questions: string[];
}

export interface SqlPair {
  question: string;
  sql: string;
}

export interface TableSchema {
  table: string;
  alias: string;
  description: string;
  keyColumns: string[];
}

export interface Relationship {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  type: string;
}

// ─── Instructions (business rules the LLM must follow) ───────────────────────

export const INSTRUCTIONS: Instruction[] = [
${emitInstructions(instructions)}
];

// ─── SQL Pairs (example question -> SQL for RAG) ─────────────────────────────

export const SQL_PAIRS: SqlPair[] = [
${emitSqlPairs(sqlPairs)}
];

// ─── PostgreSQL schema reference (ps_* tables, key columns) ──────────────────

export const SCHEMA: TableSchema[] = [
${emitSchema(schema)}
];

// ─── Relationships ───────────────────────────────────────────────────────────

export const RELATIONSHIPS: Relationship[] = [
${emitRelationships(relationships)}
];
`;

  // Atomic write via temp file + rename
  const tmpFile = OUTPUT_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpFile, ts, "utf8");
    fs.renameSync(tmpFile, OUTPUT_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }

  console.log(`[build-knowledge] Generated ${OUTPUT_FILE}`);
  console.log(`  SCHEMA:        ${schema.length} tables`);
  console.log(`  RELATIONSHIPS: ${relationships.length}`);
  console.log(`  INSTRUCTIONS:  ${instructions.length}`);
  console.log(`  SQL_PAIRS:     ${sqlPairs.length}`);
  if (skippedFiles.length) {
    console.log(`  Skipped MDs:   ${skippedFiles.join(", ")}`);
  }
}

main();
