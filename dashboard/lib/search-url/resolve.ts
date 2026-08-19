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
 *   0. OVERRIDE (issue #478) — an owner-pinned URL in profile_connector_filter
 *      for this (profile × portal × section) → use it VERBATIM, loosened []; the
 *      owner tuned it by hand so it beats every derived tier and is never
 *      re-substituted. Matched by section_key == the task's categoryKey (or ''
 *      for a whole-connector override). Task id/label preserved, so the
 *      capture_task_run staleness ledger survives. A capture portal with no
 *      builder (altamira) + an override SYNTHESIZES its first task.
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
import {
  findOverridesForProfile,
  type ProfileConnectorFilterRow,
} from "@/lib/db/profile-connector-filter";
import { fallbackTaskId, portalTitle } from "@/lib/captura-tasks";
import { BUILDERS, canonicalScopeFromProfile } from "./index";
import { toCaptureUrl } from "./capture-url";
import { municipioForPoint } from "./municipios";
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
  // "grammar" is never produced via the unfilled/substitute() path (it is a
  // whole-URL flag builders attach directly, e.g. Hipoges, issue #561) — this
  // entry exists only so the Record<LoosenableConstraint, string> stays total.
  grammar: "La gramática de esta URL no está confirmada.",
};

function unfilledFlags(unfilled: readonly LoosenableConstraint[]): LoosenedConstraint[] {
  return unfilled.map((c) => ({ constraint: c, reason: UNFILLED_REASON[c] }));
}

/**
 * The owner-pinned override that governs a task, or null. Matches on the task's
 * decoded `categoryKey` (section + sorted types); a `section_key = ''` override
 * covers every task of the connector. An exact section match wins over a
 * whole-connector one. `categoryKey` is "" for an unparseable URL (e.g. a
 * `shape=` drawn zone) — a '' override still applies, which is what we want
 * (tier 0 is verbatim and needs no parse).
 */
function overrideForTask(
  overrides: readonly ProfileConnectorFilterRow[],
  portal: string,
  categoryKey: string,
): ProfileConnectorFilterRow | null {
  const forPortal = overrides.filter((o) => o.connector === portal);
  if (forPortal.length === 0) return null;
  return (
    forPortal.find((o) => o.section_key === categoryKey) ??
    forPortal.find((o) => o.section_key === "") ??
    null
  );
}

/** Apply an override to a base task: verbatim URL, no loosening, flagged. */
function applyOverride(baseTask: SearchTask, override: ProfileConnectorFilterRow): SearchTask {
  return { ...baseTask, url: override.url, loosened: [], overridden: true };
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
  overrides: readonly ProfileConnectorFilterRow[],
): SearchTask {
  // Tier 0 (issue #478) — an owner-pinned override beats everything derived.
  // Match on the task's decoded categoryKey; keep id/label so the staleness
  // ledger (capture_task_run) survives the URL swap.
  const parsedSelf = parser.parse(baseTask.url);
  const override = overrideForTask(overrides, baseTask.portal, parsedSelf?.categoryKey ?? "");
  if (override) return applyOverride(baseTask, override);

  // Parse the builder's OWN task URL → the section + location slug this profile
  // resolves to (drift-proof: build → parse can't diverge from parse()).
  const self = parsedSelf;
  if (!self) return baseTask;

  // CONCRETE, code-pinned geometry (issue #471, D-090/#444): when the builder
  // emitted a drawn polygon (`shape`) or a multi-zone URL, the geometry is a
  // faithful rendering of the profile's OWN circle — no learned example may
  // relocate it. This makes the #444 municipality-crossing rewrite structurally
  // impossible for Idealista (its builder now always emits a shape): only a
  // tier-0 owner override (checked above) can replace it. Skip tiers 1-3.
  if (self.filters.geoKind === "shape" || self.filters.geoKind === "multi") return baseTask;

  const sameSection = examples.filter((e) => e.category_key === self.categoryKey);
  if (sameSection.length === 0) return baseTask;

  // Tier 1 — exact section + exact location slug the profile resolves to.
  const exact = sameSection.find((e) => e.filters.locationSlug === self.filters.locationSlug);
  if (exact) {
    const { url, unfilled } = parser.substitute(exact.template, canonical);
    return { ...baseTask, url, loosened: unfilledFlags(unfilled) };
  }

  // Tier 2 is DELIBERATELY gated on the geography being uncertain (issue #444).
  //
  // Idealista search URLs are deterministic: the path carries a real
  // `<municipio>-<provincia>` slug (e.g. `sevilla-sevilla`), which the code
  // builder resolves from the profile centre via municipioForPoint(). When the
  // builder DID pin a concrete municipio, that slug is authoritative (D-090:
  // URL building is code-driven) and a learned example from a *different* nearby
  // town must NEVER move the search there. The old tier-2 "same rough area"
  // reuse (AREA_MATCH_KM = 25 km) crossed municipality lines: Sevilla ↔ Dos
  // Hermanas are ~13 km apart, so a single Dos Hermanas capture silently
  // rewrote the Sevilla profile's URL to `dos-hermanas-sevilla`. Skip tier-2
  // whenever the builder resolved a concrete municipio; tier-1 (exact same-slug
  // filter-grammar refinement) above still applies. Tier-2 survives only for the
  // province/national FALLBACK case, where the builder itself could not name a
  // town and a nearby learned example is a legitimate (flagged) narrowing.
  //
  // Hipoges is EXEMPT from this gate (issue #561 review) — unlike idealista's
  // slug, its `:town` is an admitted guess (reused from idealista/aliseda's
  // OWN municipio table, never confirmed as Hipoges' own spelling), so it is
  // never "authoritative" the way D-090 means for idealista. Gating tier-2 on
  // "a municipio resolved" would disable same-area reuse in EXACTLY the two
  // markets this tool operates in (Costa del Sol / greater Sevilla), which is
  // backwards for a portal whose whole point is that a real capture should be
  // able to correct a nearby guess.
  if (baseTask.portal !== "hipoges" && municipioForPoint(canonical.center)) return baseTask;

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
 * Synthesize a task for a capture portal that has NO builder (e.g. altamira)
 * from an owner-pinned override — the override gives the portal its first search
 * URL without writing a builder (issue #478). Id = djb2 hash of `portal|url`
 * (fallbackTaskId), so the staleness ledger keys on a stable id.
 */
function synthesizeOverrideTask(override: ProfileConnectorFilterRow): SearchTask {
  return {
    id: fallbackTaskId(override.connector, override.url),
    portal: override.connector,
    label: `${portalTitle(override.connector)} — URL fijada`,
    url: override.url,
    // Recomputed from url by resolveSearchTasks' withCaptureUrl; the default
    // keeps this a valid SearchTask on its own (#529).
    captureUrl: override.url,
    loosened: [],
    overridden: true,
  };
}

/**
 * Resolve the pre-filtered search TASKS for a profile scope, preferring an
 * owner-pinned override (tier 0, #478) then learned examples (#293) over the
 * hand-written builders — the learned-aware replacement for buildSearchUrls().
 * Same flat `SearchTask[]` shape and CAPTURE_PORTALS order. `profileId` scopes
 * the override lookup (break-by-default over the old single-arg signature).
 */
export async function resolveSearchTasks(scope: Scope, profileId: number): Promise<SearchTask[]> {
  const canonical = canonicalScopeFromProfile(scope);
  // Load every owner-pinned override for the profile once (tier 0).
  const overrides = await findOverridesForProfile(profileId);
  const out: SearchTask[] = [];
  // Derive each emitted task's capture-open URL from its FINAL `url` (issue
  // #529): tier-0 overrides and learned examples can rewrite `url`, so
  // captureUrl is recomputed here rather than trusting the builder's default.
  // `url` itself is left untouched (verbatim/canonical for display + pin, D-101).
  const withCaptureUrl = (t: SearchTask): SearchTask => ({
    ...t,
    captureUrl: toCaptureUrl(t.portal, t.url),
  });
  for (const { portal } of CAPTURE_PORTALS) {
    const builder = BUILDERS[portal];
    if (!builder) {
      // No builder (altamira): the portal has no derived URL, but an owner
      // override can still give it one — synthesize a task per override.
      for (const o of overrides.filter((x) => x.connector === portal)) {
        out.push(withCaptureUrl(synthesizeOverrideTask(o)));
      }
      continue;
    }

    // URL building is 100% code-driven (D-090, issue #371): the builder's
    // hard-coded per-portal map is authoritative. Discovery no longer feeds URL
    // construction — the discovered catalog is used only for drift DETECTION
    // (lib/search-url/drift.ts), surfaced on /etl/discovery. This resolver still
    // upgrades tasks from owner-navigated LEARNED examples (#293), which is a
    // separate mechanism from discovery.
    const baseTasks = builder.build(canonical);

    const parser = PARSERS[portal];
    if (!parser) {
      // No parser → we can't decode a categoryKey, so only a whole-connector
      // ('') override can match; tier 0 still applies verbatim.
      out.push(
        ...baseTasks.map((t) => {
          const o = overrideForTask(overrides, portal, "");
          return withCaptureUrl(o ? applyOverride(t, o) : t);
        }),
      );
      continue;
    }
    // Examples are only needed for tiers 1-2; tier 0 (override) is checked first
    // inside resolveTask, so we must NOT short-circuit when examples are empty
    // but an override exists.
    const examples = await findExamplesForPortal(portal);
    out.push(
      ...baseTasks.map((t) => withCaptureUrl(resolveTask(t, parser, examples, canonical, overrides))),
    );
  }
  return out;
}
