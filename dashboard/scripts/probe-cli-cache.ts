#!/usr/bin/env tsx
/**
 * F-0c / 0c — CLI prompt-cache probe (docs/roadmap/llm-batching-plan.md Phase 0).
 *
 * Every planned batching/merging optimisation (F-1 flow-major ordering, F-2
 * moving redflags' trending/dismissed blocks out of STABLE, F-6 cache TTL,
 * D-A's "triage" merge) is valued on the assumption that a STABLE prompt
 * prefix gets cheaper on a repeat call — true for OpenRouter's Anthropic
 * prompt caching, and (as of the 2026-08-18 Phase 0 run recorded in
 * docs/roadmap/llm-batching-plan.md's Phase 0 section) ALSO true for the CLI
 * path: two back-to-back single-shot calls with an identical ~20k-char stable
 * prefix showed the second call reading back 100% of the first call's
 * cache-write tokens. `claude -p` is an agent harness, not a raw completion
 * endpoint, so this was worth measuring rather than assuming — kept as a
 * script (not a one-off finding) so the measurement can be re-run after a
 * CLI update or a stdin-shape change (e.g. F-13 splitting system/task).
 *
 * This script fires TWO consecutive `claudeCliSingleShot` calls (the actual
 * function every CLI-path flow goes through — see D-102/`lib/llm-provider/cli/usage.ts`)
 * with a large IDENTICAL stable prefix and a trivial task suffix, and prints
 * each call's `cache_read_input_tokens` / `cache_creation_input_tokens` /
 * `total_cost_usd` from the D-102 usage envelope. It does not write to
 * `llm_usage` or need a DB — this is a standalone measurement, not a
 * production code path.
 *
 * Costs a few cents of notional CLI quota (D-102 caveat: under OAuth this is
 * a comparison metric, not an invoice) — expected and fine for a one-off
 * Phase 0 measurement.
 *
 * Usage:
 *   npx tsx scripts/probe-cli-cache.ts
 *
 * Requires a working `claude` CLI on PATH with valid credentials (same
 * requirement as the dashboard's CLI provider in production).
 */

import { fileURLToPath } from "url";
import { loadDashboardLlmConfig } from "../lib/llm-provider/config";
import { claudeCliSingleShot } from "../lib/llm-provider/cli/claude-code";

/**
 * A stable block sized to resemble a real assessment flow's cacheable prefix
 * (occupancy's measured stable prompt is ~7,537 chars per the batching plan;
 * this repeats a fixed paragraph to land in the same order of magnitude) —
 * IDENTICAL text on both calls is the entire point of the probe.
 */
export function buildStablePrefix(): string {
  const paragraph =
    "Eres un asistente que analiza anuncios inmobiliarios españoles para un " +
    "inversor particular. Debes evaluar cada inmueble con criterio conservador, " +
    "citando siempre la evidencia textual concreta del anuncio que respalda tu " +
    "conclusión. No inventes datos que no aparezcan en la descripción. Si la " +
    "información es ambigua o insuficiente, marca el resultado como desconocido " +
    "en lugar de adivinar. Esta instrucción se repite para simular el tamaño de " +
    "un bloque de sistema estable de un flujo de evaluación real. ";
  return paragraph.repeat(40); // ≈ 7,000-8,000 chars, in line with the plan's measured sizes.
}

const STABLE_PREFIX = buildStablePrefix();
const TASK_SUFFIX = "\n\nReply with exactly: OK";

export interface ProbeResult {
  label: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number;
}

export type CacheVerdict =
  | { kind: "works"; cacheReadTokens: number }
  | { kind: "inconclusive" }
  | { kind: "not_observed"; cacheReadTokens: number };

/**
 * Pure classification of the SECOND call's usage envelope against the F-0c
 * question ("does a repeat call read back the first call's cache write?").
 * Extracted from `main()` so it's testable without spawning the real CLI.
 */
export function classifyCacheVerdict(second: ProbeResult): CacheVerdict {
  const secondReadTokens = second.cache_read_input_tokens ?? 0;
  if (secondReadTokens > 0) {
    return { kind: "works", cacheReadTokens: secondReadTokens };
  }
  if (second.cache_creation_input_tokens === null && second.cache_read_input_tokens === null) {
    return { kind: "inconclusive" };
  }
  return { kind: "not_observed", cacheReadTokens: secondReadTokens };
}

function describeVerdict(v: CacheVerdict): string {
  switch (v.kind) {
    case "works":
      return `CROSS-INVOCATION CACHING WORKS: call 2 reported cache_read_input_tokens=${v.cacheReadTokens}.`;
    case "inconclusive":
      return (
        "INCONCLUSIVE: the CLI reported no cache fields at all on call 2 (older binary or shape drift) — " +
        "cannot tell whether caching works from this envelope."
      );
    case "not_observed":
      return (
        "NO CROSS-INVOCATION CACHING OBSERVED: call 2 reported cache_read_input_tokens=" +
        `${v.cacheReadTokens} (0 or unreported) despite an identical stable prefix. Each ` +
        "single-shot `claude -p` invocation appears to be a fresh process with no prefix cache reuse."
      );
  }
}

async function runOnce(label: string): Promise<ProbeResult> {
  const cfg = loadDashboardLlmConfig();
  const started = Date.now();
  const { usage } = await claudeCliSingleShot({
    cfg,
    prompt: STABLE_PREFIX + TASK_SUFFIX,
  });
  const durationMs = Date.now() - started;
  return {
    label,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    total_cost_usd: usage?.cost_usd ?? null,
    duration_ms: durationMs,
  };
}

function printResult(r: ProbeResult): void {
  console.log(`\n${r.label}`);
  console.log(`  prompt_tokens:                ${r.prompt_tokens ?? "unreported"}`);
  console.log(`  completion_tokens:            ${r.completion_tokens ?? "unreported"}`);
  console.log(`  cache_creation_input_tokens:  ${r.cache_creation_input_tokens ?? "unreported"}`);
  console.log(`  cache_read_input_tokens:      ${r.cache_read_input_tokens ?? "unreported"}`);
  console.log(`  total_cost_usd:               ${r.total_cost_usd ?? "unreported"}`);
  console.log(`  duration_ms:                  ${r.duration_ms}`);
}

async function main() {
  console.log("F-0c CLI prompt-cache probe");
  console.log("============================");
  console.log(`Stable prefix length: ${STABLE_PREFIX.length} chars (identical on both calls)`);

  const first = await runOnce("Call 1 (cold — expect a cache WRITE, if the CLI caches at all)");
  printResult(first);

  const second = await runOnce("Call 2 (repeat — expect a cache READ if cross-invocation caching works)");
  printResult(second);

  console.log("\nVerdict");
  console.log("=======");
  console.log(describeVerdict(classifyCacheVerdict(second)));

  process.exit(0);
}

// Only run when executed directly (`npx tsx scripts/probe-cli-cache.ts`), not
// when imported by the test suite for the pure helpers above (same guard
// build-knowledge.ts uses).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[probe-cli-cache] failed:", err);
    process.exit(1);
  });
}
