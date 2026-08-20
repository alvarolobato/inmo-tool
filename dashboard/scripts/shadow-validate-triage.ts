#!/usr/bin/env tsx
/**
 * #542 (docs/roadmap/llm-batching-plan.md, Phase 2 PR 2a) — SHADOW VALIDATION
 * for the merged `triage` flow. This is the exit gate the plan requires
 * BEFORE PR 2a merges:
 *
 *   "run triage in compute-only mode over ~100 already-assessed eligible
 *    properties and diff per-axis labels against stored verdicts. Acceptance:
 *    ≥95% agreement where stored confidence ≥0.6; every disagreement listed
 *    in the PR. Cost ≈ under $1 notional."
 *
 * ## This gate is UNRUN as of this PR
 *
 * `dashboard.llm_enabled` is currently `false` in the owner's config (D-105),
 * and enabling it (plus spending the notional quota this script costs) is the
 * owner's call, not something an agent should do unilaterally. This script
 * exists so the owner (or a future agent, once explicitly told to spend) can
 * run it in one command and get a pass/fail verdict — it is NOT a substitute
 * for actually running it. PR 2a is filed with this gate outstanding; see the
 * PR body for the exact command and what "pass" looks like.
 *
 * ## What it does
 *
 *   1. Selects up to `--limit` (default 100) properties that are BOTH
 *      assessment-eligible (`assessmentEligibleClause` — matched by an active
 *      profile, a readable non-disabled listing) AND already carry a STORED
 *      `condition` verdict (any prompt_version — the pre-merge one, in
 *      practice, since nothing has run under `triage` yet).
 *   2. For each property, loads its listings and calls the REAL `triage` LLM
 *      call (`assessTriage`) — genuine spend, ~$0.003-0.006/property per the
 *      batching plan's economics, so ~100 properties is comfortably under $1
 *      notional (D-102 caveat: under OAuth this is a comparison metric, not
 *      an invoice).
 *   3. Parses the response with the REAL parser (`parseTriageArray` —
 *      `lib/ai-assessment/triage.ts`, the exact code path production uses)
 *      and diffs each axis's PRIMARY label against the property's currently
 *      STORED verdict:
 *        - condition:   `condition` (the 4-value enum)
 *        - location:    `beach_proximity` + `heritage_zone`
 *        - opportunity: `is_vpo` + `tourist_license`
 *   4. Prints per-axis agreement (overall, and restricted to stored
 *      `confidence >= 0.6`) and lists EVERY disagreement.
 *
 * ## Compute-only — writes NOTHING to `ai_assessment`
 *
 * This script NEVER calls `saveConditionAssessment`/`saveLocationAssessment`/
 * `saveOpportunityAssessment` (or `assessPropertyTriage`, which would). It
 * reads the stored verdict, computes a NEW one via the real LLM call, and
 * only ever writes to stdout. Re-running it costs the same $ again — that is
 * the intended trade for "never mutates the DB you're validating against".
 *
 * ## Usage
 *
 *   npx tsx scripts/shadow-validate-triage.ts [--limit 100] [--seed]
 *
 * Requires POSTGRES_DSN (or the usual PG* env vars) pointed at the DB to
 * validate against, `dashboard.llm_enabled=true`, and a working LLM provider
 * (CLI credentials or OPENROUTER_API_KEY per `DASHBOARD_LLM_PROVIDER`).
 * `--seed` makes the property sample deterministic (`ORDER BY p.id` instead
 * of `ORDER BY random()`) for a repeatable re-run.
 */

import { fileURLToPath } from "url";
import { sql } from "../lib/db-write";
import { assessTriage } from "../lib/llm";
import {
  parseTriageArray,
  type TriageAxis,
  type TriageParseRequest,
} from "../lib/ai-assessment/triage";
import { loadPropertyListings } from "../lib/ai-assessment/shared";
import { DISABLED_SOURCES_CTE, assessmentEligibleClause } from "../lib/ai-assessment/eligibility";

const DEFAULT_LIMIT = 100;
/** Below this stored confidence, a disagreement isn't held against the acceptance rate (the plan's own threshold). */
const CONFIDENCE_THRESHOLD = 0.6;
/** The plan's acceptance bar, restricted to confidence >= CONFIDENCE_THRESHOLD. */
const ACCEPTANCE_RATE = 0.95;

interface StoredVerdict {
  property_id: number;
  assessment_type: string;
  result: Record<string, unknown>;
  confidence: number | null;
}

interface Comparison {
  propertyId: number;
  axis: TriageAxis;
  field: string;
  stored: unknown;
  fresh: unknown;
  storedConfidence: number | null;
  agree: boolean;
}

/** `terreno` excludes location/opportunity — same rule `triage.ts`'s `applicableAxes` enforces (D-095/#398). */
function applicableAxesFor(propertyType: string | null | undefined): TriageAxis[] {
  const isTerreno = (propertyType ?? "").trim().toLowerCase() === "terreno";
  return isTerreno ? ["condition"] : ["condition", "location", "opportunity"];
}

async function selectSampleProperties(limit: number, deterministic: boolean): Promise<number[]> {
  const order = deterministic ? "p.id ASC" : "random()";
  const rows = await sql<{ id: string }>(
    `WITH ${DISABLED_SOURCES_CTE}
     SELECT p.id
       FROM property p
      WHERE ${assessmentEligibleClause("p")}
        AND EXISTS (
              SELECT 1 FROM ai_assessment a
               WHERE a.property_id = p.id AND a.assessment_type = 'condition'
            )
      ORDER BY ${order}
      LIMIT $1`,
    [String(limit)],
  );
  return rows.map((r) => Number(r.id));
}

async function loadStoredVerdicts(propertyId: number): Promise<Map<TriageAxis, StoredVerdict>> {
  const rows = await sql<StoredVerdict>(
    `SELECT DISTINCT ON (assessment_type) property_id, assessment_type, result, confidence
       FROM ai_assessment
      WHERE property_id = $1 AND assessment_type IN ('condition', 'location', 'opportunity')
      ORDER BY assessment_type, generated_at DESC NULLS LAST, id DESC`,
    [propertyId],
  );
  const byAxis = new Map<TriageAxis, StoredVerdict>();
  for (const row of rows) byAxis.set(row.assessment_type as TriageAxis, row);
  return byAxis;
}

const AXIS_FIELDS: Record<TriageAxis, string[]> = {
  condition: ["condition"],
  location: ["beach_proximity", "heritage_zone"],
  opportunity: ["is_vpo", "tourist_license"],
};

function compareAxis(
  propertyId: number,
  axis: TriageAxis,
  stored: StoredVerdict | undefined,
  fresh: Record<string, unknown> | undefined,
): Comparison[] {
  if (!stored || !fresh) return [];
  return AXIS_FIELDS[axis].map((field) => {
    const storedValue = stored.result[field];
    const freshValue = fresh[field];
    return {
      propertyId,
      axis,
      field,
      stored: storedValue,
      fresh: freshValue,
      storedConfidence: stored.confidence,
      agree: storedValue === freshValue,
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : DEFAULT_LIMIT;
  const deterministic = args.includes("--seed");

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid --limit: ${args[limitArg + 1]}`);
  }

  console.log("#542 triage shadow validation");
  console.log("==============================");
  console.log(`Sampling up to ${limit} eligible, already-assessed properties` + (deterministic ? " (deterministic order)." : " (random order)."));

  const propertyIds = await selectSampleProperties(limit, deterministic);
  console.log(`Selected ${propertyIds.length} properties.\n`);

  const comparisons: Comparison[] = [];
  let skipped = 0;

  for (const propertyId of propertyIds) {
    const listings = await loadPropertyListings(propertyId);
    if (listings.length === 0) {
      skipped += 1;
      continue;
    }
    const axes = applicableAxesFor(listings[0].propertyType);
    const stored = await loadStoredVerdicts(propertyId);

    const { text } = await assessTriage([{ propertyId, listings, axes }]);
    const request: TriageParseRequest = { propertyId, axes, listings };
    const parsedByProperty = parseTriageArray(text, [request]);
    const fresh = parsedByProperty.get(propertyId);

    if (!fresh) {
      console.warn(`[shadow-validate-triage] property=${propertyId}: no usable entry in the response — skipped.`);
      skipped += 1;
      continue;
    }

    for (const axis of axes) {
      const freshAxis = fresh[axis] as Record<string, unknown> | undefined;
      comparisons.push(...compareAxis(propertyId, axis, stored.get(axis), freshAxis));
    }
  }

  console.log(`\nCompared ${comparisons.length} (property, axis, field) triples across ${propertyIds.length - skipped} properties (${skipped} skipped — no listings or no usable response).\n`);

  // ── Per-axis/field agreement ────────────────────────────────────────────
  const byKey = new Map<string, Comparison[]>();
  for (const c of comparisons) {
    const key = `${c.axis}.${c.field}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(c);
  }

  let overallHighConfTotal = 0;
  let overallHighConfAgree = 0;
  const disagreements: Comparison[] = [];

  console.log("Per-field agreement (stored confidence >= " + CONFIDENCE_THRESHOLD + "):");
  for (const [key, list] of [...byKey.entries()].sort()) {
    const highConf = list.filter((c) => (c.storedConfidence ?? 0) >= CONFIDENCE_THRESHOLD);
    const agree = highConf.filter((c) => c.agree).length;
    const rate = highConf.length > 0 ? agree / highConf.length : null;
    console.log(
      `  ${key.padEnd(24)} ${agree}/${highConf.length}` +
        (rate !== null ? ` (${(rate * 100).toFixed(1)}%)` : " (no high-confidence rows)"),
    );
    overallHighConfTotal += highConf.length;
    overallHighConfAgree += agree;
    for (const c of list) if (!c.agree) disagreements.push(c);
  }

  const overallRate = overallHighConfTotal > 0 ? overallHighConfAgree / overallHighConfTotal : null;
  console.log(
    `\nOVERALL (confidence >= ${CONFIDENCE_THRESHOLD}): ${overallHighConfAgree}/${overallHighConfTotal}` +
      (overallRate !== null ? ` = ${(overallRate * 100).toFixed(1)}%` : " (no comparable rows)"),
  );
  console.log(`Acceptance threshold: >= ${(ACCEPTANCE_RATE * 100).toFixed(0)}%.`);

  console.log("\nEvery disagreement (including confidence < " + CONFIDENCE_THRESHOLD + "):");
  if (disagreements.length === 0) {
    console.log("  (none)");
  } else {
    for (const d of disagreements) {
      console.log(
        `  property=${d.propertyId} ${d.axis}.${d.field}: stored=${JSON.stringify(d.stored)} ` +
          `fresh=${JSON.stringify(d.fresh)} (stored confidence=${d.storedConfidence ?? "null"})`,
      );
    }
  }

  const pass = overallRate !== null && overallRate >= ACCEPTANCE_RATE;
  console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL/INCONCLUSIVE"}`);
  process.exit(pass ? 0 : 1);
}

// Only run when executed directly, not when imported (none of this module's
// helpers are currently imported elsewhere, but the guard matches the other
// scripts in this directory for consistency).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[shadow-validate-triage] failed:", err);
    process.exit(1);
  });
}
