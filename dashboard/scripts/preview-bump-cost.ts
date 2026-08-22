#!/usr/bin/env tsx
/**
 * F-7 pre-bump cost preview CLI (docs/roadmap/llm-batching-plan.md Phase 0,
 * PR 0b). Run this BEFORE bumping a `*_PROMPT_VERSION` constant, so the
 * reopened-backlog cost is a number you saw, not a surprise on `/admin/llm`
 * the next morning.
 *
 * Why a script and not an admin-page block: a bump preview is checked at ONE
 * moment — right before an agent edits a `*_PROMPT_VERSION` constant and opens
 * that PR — never polled. Building it as a live panel would mean a new API
 * route, response types threaded through `LlmHealthResponse`, and a form
 * widget for typing hypothetical versions that render once and are then
 * stale — all for a check that happens a handful of times per phase. The
 * underlying arithmetic (`previewBumpCost`, `lib/ai-assessment/bump-preview.ts`)
 * is the reusable, tested part; this script is a thin CLI shell over it, and
 * nothing stops a future admin "bump preview" form from calling the
 * same function if it turns out to be wanted more often (see PR body).
 *
 * Usage:
 *   npx tsx scripts/preview-bump-cost.ts <type>=<hypothetical_version> [...]
 *
 * Example (previewing the Phase 2 wave from the batching plan):
 *   npx tsx scripts/preview-bump-cost.ts \
 *     occupancy=occupancy/v3 condition=condition/v3 redflags=redflags/v9
 *
 * Requires POSTGRES_DSN (or the usual PG* env vars) pointed at the DB to
 * preview against — same connection `lib/db.ts` uses everywhere else.
 */

import { previewBumpCost, type BumpPreviewRequest } from "../lib/ai-assessment/bump-preview";

function parseArgs(argv: string[]): BumpPreviewRequest[] {
  const requests: BumpPreviewRequest[] = [];
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq <= 0 || eq === arg.length - 1) {
      throw new Error(`Invalid argument "${arg}" — expected <assessment_type>=<hypothetical_version>`);
    }
    requests.push({
      assessmentType: arg.slice(0, eq).trim(),
      hypotheticalVersion: arg.slice(eq + 1).trim(),
    });
  }
  return requests;
}

function formatEur(n: number | null): string {
  if (n === null) return "sin datos (0 llamadas recientes)";
  return `€${n.toFixed(2)}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: tsx scripts/preview-bump-cost.ts <assessment_type>=<hypothetical_version> [...]");
    console.log("");
    console.log("Example:");
    console.log("  tsx scripts/preview-bump-cost.ts occupancy=occupancy/v3 condition=condition/v3");
    process.exit(1);
  }

  const requests = parseArgs(args);
  const summary = await previewBumpCost(requests);

  console.log("F-7 pre-bump cost preview");
  console.log("==========================");
  for (const f of summary.flows) {
    console.log("");
    console.log(`${f.assessmentType} -> ${f.hypotheticalVersion}`);
    console.log(`  elegibles (assessmentEligibleClause):  ${f.eligible}`);
    console.log(`  reabiertas por el bump:                 ${f.reopened}`);
    console.log(`  coste medio/llamada (7d, llm_usage):    ${formatEur(f.avg_cost_eur_per_call)}`);
    console.log(`  coste proyectado del bump:               ${formatEur(f.projected_cost_eur)}`);
  }
  console.log("");
  console.log(`TOTAL proyectado: ${formatEur(summary.total_projected_cost_eur)}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[preview-bump-cost] failed:", err);
  process.exit(1);
});
