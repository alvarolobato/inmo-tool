/**
 * Shared prompt-formatting helpers.
 *
 * These were previously private to prompts.ts / creation-prompts.ts.
 * Centralised here so all prompt builders (generate, modify, analyze,
 * suggest, gap, weekly, free-chat) draw from a single source.
 */

import type {
  TableSchema,
  Relationship,
  Instruction,
  SqlPair,
} from "@/lib/knowledge";

export function formatSchema(schema: TableSchema[]): string {
  const lines = schema.map(
    (t) =>
      `- **${t.table}** (${t.alias}): ${t.description}\n  Columns: ${t.keyColumns.join(", ")}`,
  );
  return `## PostgreSQL Schema (ps_* tables)\n\n${lines.join("\n\n")}`;
}

export function formatRelationships(rels: Relationship[]): string {
  const lines = rels.map(
    (r) => `- ${r.from}.${r.fromColumn} → ${r.to}.${r.toColumn} (${r.type})`,
  );
  return `## Table Relationships\n\n${lines.join("\n")}`;
}

export function formatInstructions(instructions: Instruction[]): string {
  const lines = instructions.map((inst, i) => `${i + 1}. ${inst.instruction}`);
  return `## Business Rules\n\n${lines.join("\n")}`;
}

export function formatSqlPairs(pairs: SqlPair[]): string {
  const lines = pairs.map((p) => `Q: ${p.question}\nSQL: ${p.sql}`);
  return `## Example SQL Patterns (${pairs.length} pairs)\n\nUse these as reference for writing correct SQL:\n\n${lines.join("\n\n")}`;
}
