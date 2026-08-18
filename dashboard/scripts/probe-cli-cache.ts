#!/usr/bin/env tsx
/**
 * F-0c / 0c — CLI prompt-cache probe (docs/roadmap/llm-batching-plan.md Phase 0).
 *
 * Every planned batching/merging optimisation (F-1 flow-major ordering, F-2
 * moving redflags' trending/dismissed blocks out of STABLE, F-6 cache TTL,
 * D-A's "triage" merge) is valued on the assumption that a STABLE prompt
 * prefix gets cheaper on a repeat call. `claude -p` is an agent harness, not a
 * raw completion endpoint, so that is worth measuring rather than assuming.
 *
 * WHAT THE 2026-08-18 RE-RUN SHOWED (Haiku 4.5, 20,120-char / ~5.8k-token
 * stable block, prompts nonced so none had ever been sent before — full
 * numbers in the Phase 0 section of the plan):
 *
 *   A2. stable block in stdin, tail VARIES        → write 5,826, read 0     $0.0200
 *   B.  same, byte-identical repeat of A2         → write 0,     read 5,826 $0.0102
 *   C2. stable block in `--system-prompt`, varies → write 255,   read 5,498 $0.0058
 *
 * A2 vs B says the cache breakpoint sits at the END of the stdin prompt: only
 * a byte-identical prompt hits, which production never produces. C2 says the
 * same text passed via `--system-prompt` gets its own breakpoint and IS reused
 * across a differing tail — ~71% off the same call. So prefix caching is
 * available to us, but only once the domain system prompt stops travelling in
 * stdin as a `## system` section (`llm-client.ts`'s `buildMessagesPlain`) and
 * moves onto the flag — the F-13 split, now measured rather than assumed.
 *
 * An earlier version of this script fired two BYTE-IDENTICAL prompts and
 * concluded from variant B alone that "caching works". That is the one thing
 * production never does; the varying tail is the whole point. Kept as a script
 * so the measurement can be re-run after a CLI update or a stdin-shape change.
 *
 * It does not write to `llm_usage` or need a DB — a standalone measurement,
 * not a production code path. Costs a few cents of notional CLI quota (D-102
 * caveat: under OAuth this is a comparison metric, not an invoice).
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
import { runCliProcess, assertCliSuccess } from "../lib/llm-provider/cli/process";
import { CLI_LEAN_ARGS, CLI_SAFETY_ARGS, parseCliReportedUsage } from "../lib/llm-provider/cli/usage";

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
  // 40 repeats ≈ 20,120 chars ≈ 5,800 tokens. Deliberately ABOVE Haiku 4.5's
  // 4,096-token minimum cacheable prefix, because below it nothing caches at
  // all — which is itself a finding (our real prompts are ~2,700 tokens).
  // `PREFIX_REPEATS` is exported so the test can pin the real size instead of
  // a stale comment.
  return paragraph.repeat(PREFIX_REPEATS);
}

export const PREFIX_REPEATS = 40;
const STABLE_PREFIX = buildStablePrefix();

// THE POINT OF THE PROBE. Two byte-identical prompts only prove whole-prompt
// reuse, which production never produces — the volatile block differs on every
// call by construction. What F-1/F-2 depend on is PREFIX reuse under a varying
// tail, so the probe must vary it. The first version of this script did not,
// and concluded the opposite of the truth.
//
// The tails must also be unique PER RUN. A first version used two fixed tails
// and, on the second run, every call reported a cache read — not prefix reuse
// but a whole-prompt hit against the *previous run's* entries, which are still
// inside the cache TTL. A run nonce makes every prompt below one the API has
// provably never seen, so any read can only come from the shared stable block.
const RUN_NONCE = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const VARYING_TAILS = [
  `\n\nExpediente ${RUN_NONCE}-a — Inmueble 1001: piso de 90 m2 a reformar. Responde: OK`,
  `\n\nExpediente ${RUN_NONCE}-b — Inmueble 1002: chalet de 200 m2 en buen estado. Responde: OK`,
];

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
 * Pure classification of ONE warm call's usage envelope against the F-0c
 * question ("did this call read back a previous call's cache write?").
 * Extracted from `main()` so it's testable without spawning the real CLI.
 * Applied per variant, since the answer differs by variant — that difference
 * IS the finding.
 */
export function classifyCacheVerdict(warm: ProbeResult): CacheVerdict {
  const readTokens = warm.cache_read_input_tokens ?? 0;
  if (readTokens > 0) {
    return { kind: "works", cacheReadTokens: readTokens };
  }
  if (warm.cache_creation_input_tokens === null && warm.cache_read_input_tokens === null) {
    return { kind: "inconclusive" };
  }
  return { kind: "not_observed", cacheReadTokens: readTokens };
}

function describeVerdict(v: CacheVerdict): string {
  switch (v.kind) {
    case "works":
      return `REUSED — cache_read_input_tokens=${v.cacheReadTokens}.`;
    case "inconclusive":
      return (
        "INCONCLUSIVE — the CLI reported no cache fields at all (older binary or shape drift); " +
        "nothing can be concluded from this envelope."
      );
    case "not_observed":
      return (
        `NOT REUSED — cache_read_input_tokens=${v.cacheReadTokens} (0 or unreported) ` +
        "despite a byte-identical stable block in the preceding call."
      );
  }
}

/** Variant A/B: production's shape — everything concatenated into stdin. */
async function runOnce(label: string, prompt: string): Promise<ProbeResult> {
  const cfg = loadDashboardLlmConfig();
  const started = Date.now();
  const { usage } = await claudeCliSingleShot({ cfg, prompt });
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

/**
 * Variant C: the SAME stable block, but carried by `--system-prompt` instead
 * of being concatenated into stdin. stdin carries only the volatile tail.
 *
 * This deliberately bypasses `claudeCliSingleShot`, which hard-codes the small
 * protocol shim as its system prompt (`SINGLE_SHOT_PRINT_ARG`) and puts every
 * domain section in stdin. That shape is what variant A measures; measuring
 * the alternative needs the alternative argv, so the probe builds it here from
 * the same exported `CLI_SAFETY_ARGS`/`CLI_LEAN_ARGS` production uses — no
 * production code path is changed to run this.
 */
async function runSystemPromptVariant(label: string, tail: string): Promise<ProbeResult> {
  const cfg = loadDashboardLlmConfig();
  const args = [
    ...cfg.cliExtraArgs,
    ...CLI_SAFETY_ARGS,
    ...CLI_LEAN_ARGS,
    "--system-prompt",
    STABLE_PREFIX,
    "-p",
    "Responde a la tarea de stdin.",
    "--model",
    cfg.cliModel,
    "--output-format",
    "json",
  ];
  const started = Date.now();
  const result = await runCliProcess({
    file: cfg.cliBin,
    args,
    stdin: tail,
    timeoutMs: cfg.cliTimeoutMs,
    maxStdoutBytes: cfg.cliMaxCaptureBytes,
    maxStderrBytes: Math.min(cfg.cliMaxCaptureBytes, 512_000),
  });
  assertCliSuccess(result, "probe system-prompt variant", [cfg.cliBin, ...args]);
  const usage = parseCliReportedUsage(JSON.parse(result.stdout.trim()));
  return {
    label,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    total_cost_usd: usage?.cost_usd ?? null,
    duration_ms: Date.now() - started,
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
  console.log(`Stable block: ${STABLE_PREFIX.length} chars — byte-identical in every call below.`);
  console.log("Variants A/B carry it in stdin (production's shape); C carries it in --system-prompt.");
  console.log(`Run nonce: ${RUN_NONCE} — every prompt below is one the API has never seen.`);

  // A vs C is the question that decides F-1/F-2: does the stable block get
  // reused when the tail differs, as it always does in production? B is the
  // control that separates "no caching at all" from "caching, but the
  // breakpoint is past the volatile part".
  const stdinVarying = await runOnce(
    "A1 (stdin, cold, tail A)",
    STABLE_PREFIX + VARYING_TAILS[0],
  );
  printResult(stdinVarying);

  const stdinVaryingSecond = await runOnce(
    "A2 (stdin, same block, DIFFERENT tail — a read here would mean prefix reuse)",
    STABLE_PREFIX + VARYING_TAILS[1],
  );
  printResult(stdinVaryingSecond);

  const stdinIdentical = await runOnce(
    "B (stdin, byte-identical repeat of A2 — control for whole-prompt reuse)",
    STABLE_PREFIX + VARYING_TAILS[1],
  );
  printResult(stdinIdentical);

  const sysCold = await runSystemPromptVariant("C1 (--system-prompt, cold, tail A)", VARYING_TAILS[0]);
  printResult(sysCold);

  const sysVarying = await runSystemPromptVariant(
    "C2 (--system-prompt, DIFFERENT tail — a read here means usable prefix reuse)",
    VARYING_TAILS[1],
  );
  printResult(sysVarying);

  console.log("\nVerdict");
  console.log("=======");
  console.log(`  A2  stdin, varying tail:          ${describeVerdict(classifyCacheVerdict(stdinVaryingSecond))}`);
  console.log(`  B   stdin, identical (control):   ${describeVerdict(classifyCacheVerdict(stdinIdentical))}`);
  console.log(`  C2  --system-prompt, varying tail: ${describeVerdict(classifyCacheVerdict(sysVarying))}`);
  console.log(
    "\n  A2 is what today's code does, and it is the one that must read 0 for\n" +
      "  'CLI caching does not help us' to be true. If C2 reads back while A2\n" +
      "  does not, caching IS available — it just requires moving the domain\n" +
      "  system prompt out of stdin and onto the flag (F-13). If B also reads\n" +
      "  0, the block is below the model's minimum cacheable size (4,096\n" +
      "  tokens on Haiku 4.5) and none of the above is measurable.",
  );

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
