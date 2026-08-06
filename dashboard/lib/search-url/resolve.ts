/**
 * Capture-to-infer resolver (issue #293) — server-only (reads the learned
 * `search_url_example` rows via lib/db/search-url-example).
 *
 * The read-path counterpart to the builders: it takes the hand-written search
 * TASKS a profile fans out into (one per portal × section, #296/#277) and
 * UPGRADES each task's URL when a learned, owner-navigated example confirms that
 * section's grammar — otherwise the hand-written task stands unchanged. This is
 * what GET /api/profiles/[id]/search-urls returns, so the `{tasks}` consumer
 * (#299) silently gets better URLs as examples accumulate; the `SearchTask`
 * shape (id/label preserved, only url/loosened may change) is unchanged.
 *
 * Matching, per task (owner-approved defaults, 2026-08-05):
 *   1. EXACT — an example for the SAME section (categoryKey) AND the SAME
 *      location slug the profile resolves to → substitute the profile's numeric
 *      values into the confirmed template. Owner-confirmed: the guessed-grammar
 *      flags the builder attaches (guessed plural, unknown subtipo, province
 *      approximation) are DROPPED — only genuine can't-express-this loosenings
 *      remain. No reuse flag.
 *   2. SAME AREA — an example for the same section whose centroid is within
 *      AREA_MATCH_KM of the profile's own centre (derived from the profile
 *      scope's lat/lng, NOT from any URL) → reuse its template (its location
 *      slug) with a "plantilla reutilizada de otra búsqueda de la zona"
 *      loosened flag.
 *   3. NONE → the hand-written task, unchanged.
 */

import type { Scope } from "@/lib/profiles-schema";
import { CAPTURE_PORTALS } from "@/lib/worklist";
import { findExamplesForPortal, type SearchUrlExampleRow } from "@/lib/db/search-url-example";
import { BUILDERS, canonicalScopeFromProfile } from "./index";
import { haversineKm } from "./parse-shared";
import { PARSERS } from "./parsers";
import type {
  CanonicalSearchScope,
  LoosenableConstraint,
  LoosenedConstraint,
  PortalSearchUrlParser,
  SearchTask,
} from "./types";

/**
 * How close (km) a learned example's centre must be to a profile's centre to
 * count as the "same rough area" for tier-2 reuse. Coarse by design — the owner
 * approved reuse-with-flag for the same rough area, and the flag makes the
 * approximation explicit to the operator.
 */
export const AREA_MATCH_KM = 25;

/** The tier-2 reuse flag: a confirmed template borrowed from a nearby search. */
const REUSE_FLAG: LoosenedConstraint = {
  constraint: "geography",
  reason:
    "Plantilla reutilizada de otra búsqueda de la zona; comprueba que cubre tu área de búsqueda.",
};

const UNFILLED_REASON: Record<LoosenableConstraint, string> = {
  price_min: "El ejemplo aprendido no filtra por precio mínimo; los resultados son más amplios.",
  price_max: "El ejemplo aprendido no filtra por precio máximo; los resultados son más amplios.",
  size_min: "El ejemplo aprendido no filtra por superficie mínima; los resultados son más amplios.",
  size_max: "El ejemplo aprendido no filtra por superficie máxima; los resultados son más amplios.",
  geography: "El ejemplo aprendido no acota la zona; los resultados son más amplios.",
  property_types: "El ejemplo aprendido no acota los tipos; los resultados son más amplios.",
  rooms: "El ejemplo aprendido no filtra por habitaciones; los resultados son más amplios.",
};

function unfilledFlags(unfilled: readonly LoosenableConstraint[]): LoosenedConstraint[] {
  return unfilled.map((c) => ({ constraint: c, reason: UNFILLED_REASON[c] }));
}

/**
 * Upgrade ONE hand-written task with a learned example if a matching one exists.
 * `baseTask` is the builder's output; `examples` are all learned rows for the
 * portal (newest first). Returns the task unchanged when nothing applies.
 */
function resolveTask(
  baseTask: SearchTask,
  parser: PortalSearchUrlParser,
  examples: readonly SearchUrlExampleRow[],
  canonical: CanonicalSearchScope,
): SearchTask {
  // Parse the builder's OWN task URL → the section + location slug this profile
  // resolves to (drift-proof: build → parse can't diverge from parse()).
  const self = parser.parse(baseTask.url);
  if (!self) return baseTask;

  const sameSection = examples.filter((e) => e.category_key === self.categoryKey);
  if (sameSection.length === 0) return baseTask;

  // Tier 1 — exact section + exact location slug the profile resolves to.
  const exact = sameSection.find((e) => e.filters.locationSlug === self.filters.locationSlug);
  if (exact) {
    const { url, unfilled } = parser.substitute(exact.template, canonical);
    return { ...baseTask, url, loosened: unfilledFlags(unfilled) };
  }

  // Tier 2 — same section, an example centroid within AREA_MATCH_KM of the
  // profile's own centre (from the scope, not a URL). Nearest wins.
  let best: SearchUrlExampleRow | null = null;
  let bestKm = Infinity;
  for (const e of sameSection) {
    if (!e.filters.center) continue;
    const km = haversineKm(canonical.center, e.filters.center);
    if (km <= AREA_MATCH_KM && km < bestKm) {
      bestKm = km;
      best = e;
    }
  }
  if (best) {
    const { url, unfilled } = parser.substitute(best.template, canonical);
    return { ...baseTask, url, loosened: [REUSE_FLAG, ...unfilledFlags(unfilled)] };
  }

  // Tier 3 — nothing learned that applies → hand-written task, unchanged.
  return baseTask;
}

/**
 * Resolve the pre-filtered search TASKS for a profile scope, preferring learned
 * examples over the hand-written builders — the learned-aware replacement for
 * buildSearchUrls(). Same flat `SearchTask[]` shape and CAPTURE_PORTALS order.
 */
export async function resolveSearchTasks(scope: Scope): Promise<SearchTask[]> {
  const canonical = canonicalScopeFromProfile(scope);
  const out: SearchTask[] = [];
  for (const { portal } of CAPTURE_PORTALS) {
    const builder = BUILDERS[portal];
    if (!builder) continue;

    // URL building is 100% code-driven (D-090, issue #371): the builder's
    // hard-coded per-portal map is authoritative. Discovery no longer feeds URL
    // construction — the discovered catalog is used only for drift DETECTION
    // (lib/search-url/drift.ts), surfaced on /etl/discovery. This resolver still
    // upgrades tasks from owner-navigated LEARNED examples (#293), which is a
    // separate mechanism from discovery.
    const baseTasks = builder.build(canonical);

    const parser = PARSERS[portal];
    if (!parser) {
      out.push(...baseTasks);
      continue;
    }
    const examples = await findExamplesForPortal(portal);
    if (examples.length === 0) {
      out.push(...baseTasks);
      continue;
    }
    out.push(...baseTasks.map((t) => resolveTask(t, parser, examples, canonical)));
  }
  return out;
}
