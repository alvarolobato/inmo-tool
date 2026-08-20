import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPoolQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class {
    query = mockPoolQuery;
    end = mockEnd;
  },
  // db-shared.ts (#155) registers the int8 type parser at module load —
  // the mock needs a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import {
  classifyPriceChange,
  decodeCursor,
  describeRankingBoost,
  flagsFromAssessments,
  getAdjacentCandidates,
  listCandidates,
  OCCUPIED_STATUSES,
  WARN_CAVEAT_CODES,
  type RawAssessmentRow,
} from "../candidates";
import { resetPool } from "@/lib/db-write";

// #310 (D-059) appended five params after WARN_CAVEAT_CODES ($6): occupancy
// ($7), the occupied-statuses list ($8), condition ($9), renovation ($10), and
// min-below-market ($11). #379 appends includeRejected ($12), false by default
// (rejected candidates hidden). #386 appends caveat ($13) and redflagType
// ($14), both null (off) by default. #392 appends beachProximity ($15) and
// heritageZone ($16), both null (off). #398 appends isVpo ($17), null (off).
// #422 appends the "En seguimiento" state filter ($18), null (off).
// This is the "all filters off" tail every existing listCandidates assertion
// carries now.
const NO_FILTER_TAIL = [
  null,
  OCCUPIED_STATUSES,
  null,
  null,
  null,
  false,
  null,
  null,
  null,
  null,
  null,
  null,
] as const;

// #425 appended the fresh-first threading AFTER the #422 state filter ($18):
// the keyset tier ($19, null on page 1), the session-fixed novelty anchor
// ($20), the price-change sanity band as fractions ($21/$22 — default 1%/60%),
// and the cold-start suppression decision ($23). On page 1 the anchor + cold
// start come from resolveNoveltyContext (mocked to FIXED_ANCHOR / false below).
const FIXED_ANCHOR = "2020-01-01T00:00:00.000Z";
// Page 1 (no cursor): tier is null (no keyset lower bound); anchor + cold start
// come from the resolve query (FIXED_ANCHOR / false).
const NOVELTY_TAIL_PAGE1 = [null, FIXED_ANCHOR, 0.01, 0.6, false] as const;
// Page 2 (a decoded cursor): tier + anchor + cold start come from the cursor
// (testCursor defaults tier 0 / FIXED_ANCHOR / false), NOT re-resolved.
const NOVELTY_TAIL_PAGE2 = [0, FIXED_ANCHOR, 0.01, 0.6, false] as const;

/**
 * #425: the resolve query resolveNoveltyContext issues on page 1 (and in every
 * getAdjacentCandidates call) is routed to this fixed row by the mock below, so
 * the threaded anchor / cold-start values are deterministic in assertions.
 */
const RESOLVE_ROW = {
  anchor_ts: FIXED_ANCHOR,
  never_visited: false,
  total: 0,
  fresh: 0,
};
// #425: per-test override for the resolve query's row, so the cold-start tests
// can vary never_visited / coverage. Reset to RESOLVE_ROW in beforeEach.
let resolveRow: {
  anchor_ts: string;
  never_visited: boolean;
  total: number;
  fresh: number;
};

/**
 * #425: the shared `pg` mock now serves TWO query kinds from listCandidates /
 * getAdjacentCandidates — the novelty-context resolve query (detected by its
 * `never_visited` column) and everything else (main candidate query, loadFlags,
 * adjacency). Resolve is answered transparently with RESOLVE_ROW; all other
 * calls pull from `mainQueue` in order (defaulting to an empty result), so tests
 * queue main/loadFlags/adjacency results without having to account for the
 * resolve round-trip. Push an Error to make the next non-resolve call reject.
 */
let mainQueue: Array<{ rows: unknown[] } | Error>;
function queueMain(...vals: Array<{ rows: unknown[] } | Error>): void {
  mainQueue.push(...vals);
}
function isResolveSql(text: unknown): boolean {
  return typeof text === "string" && text.includes("never_visited");
}
/** The main candidate-list query (the one carrying the fresh-first ORDER BY). */
function mainCall(): [string, unknown[]] {
  const call = mockPoolQuery.mock.calls.find(
    (c) =>
      typeof c[0] === "string" && c[0].includes("ORDER BY ranked.novelty_tier"),
  );
  if (!call) throw new Error("no main candidate query was issued");
  return call as [string, unknown[]];
}
function mainParams(): unknown[] {
  return mainCall()[1];
}
/**
 * loadFlags' ai_assessment query — identified by its distinctive
 * `DISTINCT ON (property_id, assessment_type)` (the resolve + main queries also
 * touch `ai_assessment`, but with `DISTINCT ON (a.assessment_type)`).
 */
function flagsCall(): [string, unknown[]] {
  const call = mockPoolQuery.mock.calls.find(
    (c) =>
      typeof c[0] === "string" &&
      c[0].includes("DISTINCT ON (property_id, assessment_type)"),
  );
  if (!call) throw new Error("no loadFlags query was issued");
  return call as [string, unknown[]];
}

/** The novelty-context resolve query (page 1 of listCandidates / getAdjacent). */
function resolveCall(): [string, unknown[]] {
  const call = mockPoolQuery.mock.calls.find((c) => isResolveSql(c[0]));
  if (!call) throw new Error("no resolve query was issued");
  return call as [string, unknown[]];
}

/**
 * Builds a page-2 cursor the same way `listCandidates` does internally (#425:
 * 5-element payload — tier, score, id, anchor, coldStart), purely for test
 * setup; tests otherwise treat cursors as opaque and decode `nextCursor`.
 */
function testCursor(
  score: number | null,
  id: number,
  tier = 0,
  anchorTs = FIXED_ANCHOR,
  coldStart = false,
): string {
  return Buffer.from(
    JSON.stringify([tier, score ?? -1, id, anchorTs, coldStart]),
  ).toString("base64url");
}

// File-scoped (not nested in one describe) so every describe block below
// gets a freshly-reset mock and pool — the loadFlags/getAdjacentCandidates
// suites added for the #152 review need this exactly as much as
// listCandidates's own tests do; nesting it inside `describe("listCandidates"`
// only would leave sibling describes sharing mock state across tests.
beforeEach(async () => {
  mockPoolQuery.mockReset();
  mainQueue = [];
  resolveRow = { ...RESOLVE_ROW };
  mockPoolQuery.mockImplementation((text: unknown) => {
    if (isResolveSql(text)) return Promise.resolve({ rows: [resolveRow] });
    const next = mainQueue.length > 0 ? mainQueue.shift()! : { rows: [] };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  await resetPool();
});

const stubRow = (id: number) => ({
  property_id: id,
  address: null,
  lat: null,
  lon: null,
  property_type: null,
  m2_built: null,
  rooms: null,
  min_price: null,
  first_seen_at: null,
  listings: [],
  score: null,
  rank_explanation: null,
  // #425: the leading keyset tier is projected on every main-query row and
  // folded into the cursor, so a stub must carry it (default 0 = not fresh).
  novelty_tier: 0,
});

describe("listCandidates", () => {
  it("queries profile_listing_state joined to property, filtered on matched=true", async () => {
    await listCandidates(7);

    // #425: the novelty-context resolve query + the main candidate query (no
    // loadFlags for an empty page).
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mainCall();
    expect(sql).toContain("FROM profile_listing_state pls");
    expect(sql).toContain("JOIN property p ON p.id = pls.property_id");
    expect(sql).toContain("pls.matched = true");
    expect(sql).toContain("pls.profile_id = $1");
    // Fetches one extra row (limit+1) so nextCursor reflects whether a next
    // page truly exists rather than assuming it does whenever the page
    // happens to be exactly full — see the nextCursor tests below. Params
    // are (profileId, cursorScore, cursorId, limit+1, source) — a compound
    // keyset key, not a single id, since results are ordered by score
    // globally; source ($5) is null when no portal filter is applied (#265).
    expect(params).toEqual([
      7,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
  });

  it("#416: computes novelty against previous_viewed_at, joined once, WITHOUT touching the sort", async () => {
    await listCandidates(7);

    const [sql, params] = mainCall();
    // #425: the anchor is now RESOLVED ONCE in the resolve query (the shifted
    // two-slot previous_viewed_at, NOT last_viewed_at which the profile GET
    // stamps to NOW(), with the same created_at-1day fallback new_count uses)
    // and threaded into the main query as a bound value ($20).
    const [resolveSql] = resolveCall();
    expect(resolveSql).toContain("previous_viewed_at");
    expect(resolveSql).toContain("created_at - interval '1 day'");
    // The main query's anchor CTE reads that threaded value, not the table.
    expect(sql).toContain("($20)::timestamptz AS ts");
    // A pre-aggregated novelty CTE (one row per property), joined once — never a
    // correlated subquery inside base (the D-057 anti-pattern).
    expect(sql).toContain("novelty AS (");
    expect(sql).toContain(
      "MIN(l.first_seen_at) > (SELECT ts FROM anchor) AS is_new",
    );
    expect(sql).toContain(
      "LEFT JOIN novelty nov ON nov.property_id = base.property_id",
    );
    expect(sql).toContain("COALESCE(nov.is_new, false) AS is_new");
    expect(sql).toContain("ranked.is_new");
    // #425 phase 3: is_new now ALSO feeds the leading sort tier (novelty_tier),
    // but effective_score itself is untouched — the tier is a separate key.
    expect(sql).toContain(
      "ORDER BY ranked.novelty_tier DESC, ranked.effective_score DESC, ranked.property_id DESC",
    );
    const rankedOrderBys = sql.match(/ORDER BY ranked\.[^\n]*/g) ?? [];
    expect(rankedOrderBys).toEqual([
      "ORDER BY ranked.novelty_tier DESC, ranked.effective_score DESC, ranked.property_id DESC",
    ]);
    expect(params).toEqual([
      7,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
  });

  it("#416: maps is_new true/false straight from the ranked row onto the candidate", async () => {
    queueMain({
      rows: [
        { ...stubRow(2), is_new: true },
        { ...stubRow(3), is_new: false },
        { ...stubRow(4) }, // absent (LEFT JOIN default) → not new
      ],
    });
    const page = await listCandidates(1);
    expect(page.items.map((i) => i.is_new)).toEqual([true, false, false]);
  });

  it("#420: builds a bounded, pre-aggregated price_moves CTE joined once, WITHOUT touching the sort", async () => {
    await listCandidates(7);

    const [sql, params] = mainCall();
    // A pre-aggregated CTE (one row per property via rn=1), BOUNDED to base's
    // property set through the JOIN — never a LAG() over the whole
    // listing_price_history (the digest loadPriceDrops anti-pattern §3.3 warns
    // about), and never a correlated subquery in base.
    expect(sql).toContain("price_moves AS (");
    expect(sql).toContain("JOIN base b ON b.property_id = l.property_id");
    expect(sql).toContain(
      "LAG(h.price) OVER (PARTITION BY b.property_id\n                                     ORDER BY h.observed_at, h.id) AS prev_price",
    );
    expect(sql).toContain("ROW_NUMBER() OVER (PARTITION BY b.property_id");
    expect(sql).toContain(
      "(curr_price - prev_price) / prev_price AS delta_pct",
    );
    // Change SINCE the visit anchor (same anchor as is_new), latest move only.
    expect(sql).toContain("WHERE rn = 1");
    expect(sql).toContain("observed_at > (SELECT ts FROM anchor)");
    // Joined once into ranked and surfaced as a raw delta; the sanity band is a
    // TS concern, so no threshold literal appears in the SQL.
    expect(sql).toContain(
      "LEFT JOIN price_moves pm ON pm.property_id = base.property_id",
    );
    expect(sql).toContain("pm.delta_pct AS price_delta_pct");
    expect(sql).toContain("ranked.price_delta_pct");
    // #425 phase 3: the price move now ALSO feeds the leading novelty_tier
    // (sanity-banded via $21/$22, mirroring classifyPriceChange), but the raw
    // delta is still carried presentation-only and effective_score is untouched.
    const rankedOrderBys = sql.match(/ORDER BY ranked\.[^\n]*/g) ?? [];
    expect(rankedOrderBys).toEqual([
      "ORDER BY ranked.novelty_tier DESC, ranked.effective_score DESC, ranked.property_id DESC",
    ]);
    expect(params).toEqual([
      7,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
  });

  it("#420: applies the sanity band when mapping price_delta_pct → price_changed/direction", async () => {
    queueMain({
      rows: [
        { ...stubRow(2), price_delta_pct: "-0.086" }, // -8.6% drop → BAJADA
        { ...stubRow(3), price_delta_pct: "0.077" }, // +7.7% rise → SUBIDA
        { ...stubRow(4), price_delta_pct: "-0.001" }, // -0.1% noise → no badge
        { ...stubRow(5), price_delta_pct: "-0.96" }, // -96% suspect → no badge
        { ...stubRow(6) }, // no move (LEFT JOIN default) → no badge
      ],
    });
    const page = await listCandidates(1);
    expect(page.items.map((i) => i.price_changed)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(page.items.map((i) => i.price_direction)).toEqual([
      "drop",
      "up",
      null,
      null,
      null,
    ]);
    // Raw delta is carried through even for suspects (for a data-health view),
    // null only when there was no move.
    expect(page.items.map((i) => i.price_delta_pct)).toEqual([
      -0.086,
      0.077,
      -0.001,
      -0.96,
      null,
    ]);
  });

  it("excludes rejected candidates by default and derives feedback_state (#379)", async () => {
    await listCandidates(7);

    const [sql, params] = mainCall();
    // The default feed hides rejected candidates ($12 = false), keeping the
    // reject-exclusion clause gated on the derived feedback_state.
    expect(sql).toContain("ranked.feedback_state IS DISTINCT FROM 'reject'");
    expect(sql).toContain("$12::boolean = true");
    expect(sql).toContain("AS feedback_state");
    // #404 regression guard: the verdict must also be PROJECTED by the outer
    // SELECT, not only derived in the CTE and used by the reject-exclusion
    // WHERE. It was missing here, so every fetched row omitted the column and
    // the card rendered unmarked after a reload (no "Descartada" badge, no
    // pressed toggle) even though the reject exclusion read the same value fine.
    expect(sql).toContain("ranked.feedback_state,");
    expect(params[11]).toBe(false);
  });

  it("passes includeRejected=true as $12 when the show-rejected toggle asks for it (#379)", async () => {
    await listCandidates(7, { includeRejected: true });

    expect(mainParams()[11]).toBe(true);
  });

  it("passes state='accept' as $18 for the 'En seguimiento' working set, and gates on ranked.feedback_state (#422)", async () => {
    await listCandidates(7, { state: "accept" });

    const [sql, params] = mainCall();
    // $18 (index 17) is the seguimiento state filter.
    expect(params[17]).toBe("accept");
    expect(sql).toContain("ranked.feedback_state = $18");
  });

  it("leaves the state filter off ($18 = null) by default, and for any non-'accept' value (#422)", async () => {
    await listCandidates(7);
    expect(mainParams()[17]).toBeNull();

    mockPoolQuery.mockClear();
    // Only 'accept' is a valid verdict scope today; anything else collapses to off.
    await listCandidates(7, { state: "reject" as unknown as "accept" });
    expect(mainParams()[17]).toBeNull();
  });

  it("surfaces the row's feedback_state on the mapped candidate (#379)", async () => {
    queueMain({
      rows: [
        { ...stubRow(9), feedback_state: "reject" },
        { ...stubRow(8), feedback_state: null },
      ],
    });
    const page = await listCandidates(7, { includeRejected: true });
    expect(page.items[0].feedback_state).toBe("reject");
    expect(page.items[1].feedback_state).toBeNull();
  });

  it("passes the decoded cursor and clamps limit to [1, 100] (querying limit+1 rows)", async () => {
    await listCandidates(7, { cursor: testCursor(0.73, 42), limit: 500 });
    expect(mainParams()).toEqual([
      7,
      0.73,
      42,
      101,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE2,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);

    mockPoolQuery.mockClear();
    await listCandidates(7, { limit: 0 });
    expect(mainParams()).toEqual([
      7,
      null,
      null,
      2,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
  });

  it("passes a trimmed source as $5 and adds the portal EXISTS filter (#265)", async () => {
    await listCandidates(7, { source: "  idealista  " });
    const [sql, params] = mainCall();
    // Trimmed, and the EXISTS subquery gates on the same active+sale set the
    // card's badges use.
    expect(params).toEqual([
      7,
      null,
      null,
      31,
      "idealista",
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("lf.source = $5");

    // An empty / whitespace-only source is "no filter" — $5 stays null.
    mockPoolQuery.mockClear();
    await listCandidates(7, { source: "   " });
    expect(mainParams()).toEqual([
      7,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      ...NO_FILTER_TAIL,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
      null, // #470 q ($25), off by default
    ]);
  });

  it("passes the caveat filter as $13 and gates on the derived caveats array (#386)", async () => {
    await listCandidates(7, { caveat: "venta_deuda" });
    const [sql, params] = mainCall();
    // $13 carries the caveat code; the outer filter reads ranked.caveats (the
    // CTE's per-axis column), never a separate JOIN (D-059).
    expect(params[12]).toBe("venta_deuda");
    expect(params[13]).toBeNull();
    expect(sql).toContain("$13 = ANY(ranked.caveats)");
    // The CTE derives the caveats array itself.
    expect(sql).toContain("AS caveats");
  });

  it("passes the redflagType filter as $14 and gates on the derived redflag_types array (#386)", async () => {
    await listCandidates(7, { redflagType: "unfinished_construction" });
    const [sql, params] = mainCall();
    expect(params[12]).toBeNull();
    expect(params[13]).toBe("unfinished_construction");
    expect(sql).toContain("$14 = ANY(ranked.redflag_types)");
    expect(sql).toContain("AS redflag_types");
  });

  it("combines caveat + redflagType with an existing #310 filter in one param set (#386)", async () => {
    await listCandidates(7, {
      occupancy: "occupied",
      caveat: "nuda_propiedad",
      redflagType: "embargo",
    });
    const params = mainParams();
    // $7 occupancy, $13 caveat, $14 redflagType all set together — the filters
    // compose, none clobbers another.
    expect(params[6]).toBe("occupied");
    expect(params[12]).toBe("nuda_propiedad");
    expect(params[13]).toBe("embargo");
  });

  it("passes the beachProximity filter as $15 and gates on ranked.beach_proximity by min grade (#392)", async () => {
    await listCandidates(7, { beachProximity: "sea_view" });
    const [sql, params] = mainCall();
    // $15 carries the min-grade token; the outer filter reads ranked.beach_proximity
    // (the CTE's per-axis column from the latest location row), never a JOIN (D-059).
    expect(params[14]).toBe("sea_view");
    expect(params[15]).toBeNull();
    expect(sql).toContain(
      "$15 = 'sea_view' AND ranked.beach_proximity IN ('frontline', 'sea_view')",
    );
    // The CTE derives the beach_proximity column itself from the location axis.
    expect(sql).toContain("AS beach_proximity");
    expect(sql).toContain("'occupancy', 'condition', 'redflags', 'location'");
  });

  it("passes the heritageZone toggle as $16=true and gates on ranked.heritage_zone (#392)", async () => {
    await listCandidates(7, { heritageZone: true });
    const [sql, params] = mainCall();
    expect(params[15]).toBe(true);
    expect(sql).toContain(
      "$16::boolean IS NOT TRUE OR ranked.heritage_zone = true",
    );
    expect(sql).toContain("AS heritage_zone");
  });

  it("normalises a falsy heritageZone to null so the off-tail stays uniform (#392)", async () => {
    await listCandidates(7, { heritageZone: false });
    expect(mainParams()[15]).toBeNull();
  });

  it("emits the graded beach boost in effective_score (soft, non-filtering — #392)", async () => {
    await listCandidates(7);
    const [sql] = mainCall();
    // The boost is a graded CASE on base.beach_proximity added to effective_score.
    expect(sql).toContain("CASE base.beach_proximity");
    expect(sql).toContain("WHEN 'frontline' THEN 3");
    expect(sql).toContain("WHEN 'sea_view' THEN 2");
    expect(sql).toContain("WHEN 'near_beach' THEN 1");
    expect(sql).toContain("* 0.03");
  });

  it("passes isVpo=true as $17 and gates bidirectionally on ranked.is_vpo (#398)", async () => {
    await listCandidates(7, { isVpo: true });
    const [sql, params] = mainCall();
    // $17 carries the boolean; the outer filter reads ranked.is_vpo (the CTE's
    // per-axis column from the latest opportunity row), never a JOIN (D-059).
    expect(params[16]).toBe(true);
    expect(sql).toContain(
      "$17::boolean IS NULL OR ranked.is_vpo = $17::boolean",
    );
    // The CTE derives is_vpo itself from the opportunity axis.
    expect(sql).toContain("AS is_vpo");
    expect(sql).toContain(
      "'occupancy', 'condition', 'redflags', 'location', 'opportunity'",
    );
  });

  it("passes isVpo=false as $17 (exclude-VPO direction) (#398)", async () => {
    await listCandidates(7, { isVpo: false });
    expect(mainParams()[16]).toBe(false);
  });

  it("normalises an omitted isVpo to null so the off-tail stays uniform (#398)", async () => {
    await listCandidates(7);
    expect(mainParams()[16]).toBeNull();
  });

  it("passes hasAlerts=true as $24 and gates on the UNION of redflag_types + warn caveats (#466/#593)", async () => {
    await listCandidates(7, { hasAlerts: true });
    const [sql, params] = mainCall();
    // $24 is the toggle; the warn-caveat array reuses the $6 param (D-059,
    // same array the distress boost reads), so only the boolean is new.
    expect(params[23]).toBe(true);
    expect(sql).toContain("WHEN ranked.redflag_types IS NULL THEN NULL");
    expect(sql).toContain("cardinality(ranked.redflag_types) > 0");
    expect(sql).toContain("ranked.caveats && $6::text[]");
    expect(sql).toContain("$24::boolean IS NULL");
  });

  it("passes hasAlerts=false as $24 — 'sin alertas' is NOT normalised to null, it's a real filter value now (#593)", async () => {
    await listCandidates(7, { hasAlerts: false });
    const [sql, params] = mainCall();
    expect(params[23]).toBe(false);
    // The negative reuses the EXACT SAME bracketed expression as the positive
    // (compared via `= $24::boolean`), never a second, independently-written
    // predicate — the one assertion that would catch the #590-style drift.
    expect(sql).toContain("WHEN ranked.redflag_types IS NULL THEN NULL");
    expect(sql).toContain("cardinality(ranked.redflag_types) > 0");
    expect(sql).toContain("ranked.caveats && $6::text[]");
    expect(sql).toContain(") = $24::boolean");
  });

  it("normalises an omitted hasAlerts to null so the off-tail stays uniform (#593)", async () => {
    await listCandidates(7);
    expect(mainParams()[23]).toBeNull();
  });

  it("emits the soft tourist-licence boost in effective_score (soft, non-filtering — #398)", async () => {
    await listCandidates(7);
    const [sql] = mainCall();
    // A single-boolean CASE on base.tourist_license added to effective_score.
    expect(sql).toContain(
      "CASE WHEN base.tourist_license = true THEN 0.04 ELSE 0 END",
    );
    expect(sql).toContain("AS tourist_license");
  });

  it("emits the #452 timing boosts (DOM + price-drop, joint-capped) in effective_score", async () => {
    await listCandidates(7);
    const [sql] = mainCall();
    // A dedicated `timing` CTE computes days_on_market + net price_drop_pct,
    // LEFT JOINed as `tim` and freezing DOM at the terminal-status transition.
    expect(sql).toContain("timing AS (");
    expect(sql).toContain("LEFT JOIN timing tim ON tim.property_id = base.property_id");
    expect(sql).toContain("ARRAY['sold','withdrawn','expired']::text[]");
    // DOM boost: linear ramp to 180 days × 0.04, degrades to 0 when NULL.
    expect(sql).toContain("GREATEST(tim.days_on_market, 0) / 180.0");
    expect(sql).toContain("* 0.04");
    // Price-drop boost: linear ramp to a 0.2 net drop × 0.07.
    expect(sql).toContain("GREATEST(tim.price_drop_pct, 0) / 0.2");
    expect(sql).toContain("* 0.07");
    // Joint cap 0.11 over the sum of the two.
    expect(sql).toContain(", 0.11)");
    // The two signals are also projected for the card's boost reason.
    expect(sql).toContain("ranked.days_on_market");
    expect(sql).toContain("ranked.price_drop_pct");
  });

  it("rejects a malformed cursor rather than silently resetting to page 1", async () => {
    await expect(
      listCandidates(7, { cursor: "not-valid-base64-json" }),
    ).rejects.toThrow("Cursor no válido.");
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("sets nextCursor only when a real next page exists (extra row is fetched and trimmed, not inferred from a full page)", async () => {
    // limit=2, DB returns 3 rows (limit+1) => a real next page exists.
    queueMain({ rows: [stubRow(3), stubRow(2), stubRow(1)] });
    const withMore = await listCandidates(1, { limit: 2 });
    expect(withMore.items).toHaveLength(2);
    expect(withMore.items.map((i) => i.property_id)).toEqual([3, 2]);
    // Cursor is opaque to callers — decode it to assert on its meaning
    // (resume after the last row actually returned, id=2, score=null here).
    expect(decodeCursor(withMore.nextCursor!)).toEqual({
      tier: 0,
      score: -1,
      id: 2,
      anchorTs: FIXED_ANCHOR,
      coldStart: false,
    });

    // limit=2, DB returns exactly 2 rows (no extra row) => this genuinely is
    // the last page, even though it's "full" — the bug this test guards
    // against previously showed a dead "Cargar más" here.
    queueMain({ rows: [stubRow(3), stubRow(2)] });
    const exactlyFull = await listCandidates(1, { limit: 2 });
    expect(exactlyFull.items).toHaveLength(2);
    expect(exactlyFull.nextCursor).toBeNull();

    // limit=2, DB returns 1 row => partial page, no next page.
    queueMain({ rows: [stubRow(3)] });
    const partialPage = await listCandidates(1, { limit: 2 });
    expect(partialPage.items).toHaveLength(1);
    expect(partialPage.nextCursor).toBeNull();
  });

  it("property_id (a pg bigint) reaches the API response as a real JSON number", async () => {
    // property_id used to be shipped as a raw pg bigint string ("179" not
    // 179) unless every call site remembered its own Number(...)
    // conversion — the exact bug class #155 retired by registering a
    // driver-level int8 type parser (db-shared.ts) instead. This unit test
    // mocks the `pg` module directly (see the vi.mock("pg", ...) above),
    // which bypasses that parser entirely, so the mock here supplies
    // property_id as the number the real driver now guarantees — this test
    // is a pass-through/shape guard on candidates.ts, not a test of the
    // coercion itself (that's covered by a real-Postgres test, see
    // lib/__tests__/db.test.ts).
    queueMain({
      rows: [{ ...stubRow(0), property_id: 179 }],
    });
    const page = await listCandidates(1);
    expect(page.items[0].property_id).toBe(179);
    expect(typeof page.items[0].property_id).toBe("number");
  });

  it("groups a property's multiple listings under one row (one card per property, not per listing)", async () => {
    queueMain({
      rows: [
        {
          property_id: 5,
          address: "Calle Trafalgar, Chamberí, Madrid",
          lat: "40.432400",
          lon: "-3.702500",
          property_type: "piso",
          m2_built: "70.00",
          rooms: 2,
          min_price: "279000.00",
          first_seen_at: "2026-07-01T00:00:00.000Z",
          score: "0.732",
          rank_explanation:
            "Encaja bien con tu perfil: precio un 8% por debajo de tu banda de precio.",
          listings: [
            {
              id: 10,
              source: "fotocasa",
              url: "https://fotocasa.example/10",
              current_price: 285000,
            },
            {
              id: 11,
              source: "milanuncios",
              url: "https://milanuncios.example/11",
              current_price: 279000,
            },
          ],
        },
      ],
    });

    const page = await listCandidates(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].property_id).toBe(5);
    expect(page.items[0].listings.map((l) => l.source).sort()).toEqual([
      "fotocasa",
      "milanuncios",
    ]);
    // Numeric columns come back as strings from pg for NUMERIC types — must
    // be coerced, not left as strings the UI would render/sort incorrectly.
    expect(page.items[0].lat).toBe(40.4324);
    expect(page.items[0].m2_built).toBe(70);
    expect(page.items[0].min_price).toBe(279000);
  });

  it("coerces score (a pg NUMERIC, returned as a string) to a JSON number, and passes rank_explanation through untouched", async () => {
    queueMain({
      rows: [
        {
          ...stubRow(1),
          score: "0.500",
          rank_explanation:
            "Sin motivos concretos que destacar todavía para este candidato.",
        },
      ],
    });
    const page = await listCandidates(1);
    expect(page.items[0].score).toBe(0.5);
    expect(typeof page.items[0].score).toBe("number");
    expect(page.items[0].rank_explanation).toBe(
      "Sin motivos concretos que destacar todavía para este candidato.",
    );
  });

  it("leaves score and rank_explanation null when the property hasn't been scored yet", async () => {
    queueMain({ rows: [stubRow(1)] });
    const page = await listCandidates(1);
    expect(page.items[0].score).toBeNull();
    expect(page.items[0].rank_explanation).toBeNull();
  });

  it("does not re-sort rows by score client-side — order and cursor both come straight from the SQL result", async () => {
    // Regression test (Fable review, PR #93 fix): a previous version fetched
    // rows in id order, sorted a copy by score for display, but derived
    // nextCursor from the *sorted* array's last element — since the SQL
    // ORDER BY id DESC and the display's score-DESC order don't agree, the
    // cursor ended up being an arbitrary row's id, corrupting the keyset
    // scan on the next page (skipped/duplicated rows). The fix moves
    // ordering into SQL itself, so the mocked "SQL result" below is already
    // in final (score DESC, id DESC) order — deliberately NOT id-DESC order
    // — and both `items` and `nextCursor` must reflect that order exactly,
    // with no further client-side re-sort.
    // The cursor now encodes the blended effective_score (#309), which the SQL
    // returns per row — supply it so the mock reflects the real result shape.
    queueMain({
      rows: [
        { ...stubRow(2), score: "0.900", effective_score: "0.900" }, // highest, but lowest id
        { ...stubRow(9), score: "0.500", effective_score: "0.500" },
        { ...stubRow(5), score: null, effective_score: "-1" }, // unscored sorts last (NO_SCORE_SENTINEL)
      ],
    });
    const page = await listCandidates(1, { limit: 2 });

    expect(page.items.map((i) => i.property_id)).toEqual([2, 9]);
    // Cursor must resume after row id=9 (effective_score 0.5) — the second,
    // last-kept row in this already-sorted result — not after whichever id
    // happened to sort last in some separate re-sort.
    expect(decodeCursor(page.nextCursor!)).toEqual({
      tier: 0,
      score: 0.5,
      id: 9,
      anchorTs: FIXED_ANCHOR,
      coldStart: false,
    });
  });

  it("coerces score_kind through, and defaults to null when the DB returns it undefined (older mocked rows)", async () => {
    queueMain({
      rows: [
        { ...stubRow(1), score_kind: "trained" },
        { ...stubRow(2), score_kind: null },
        stubRow(3),
      ],
    });
    const page = await listCandidates(1);
    expect(page.items.map((i) => i.score_kind)).toEqual([
      "trained",
      null,
      null,
    ]);
  });

  it("#167: passes the photos array through, defaulting to [] when the DB returns it undefined (older mocked rows)", async () => {
    queueMain({
      rows: [
        {
          ...stubRow(1),
          photos: ["https://img.example/a.jpg", "https://img.example/b.jpg"],
        },
        { ...stubRow(2), photos: [] },
        stubRow(3),
      ],
    });
    const page = await listCandidates(1);
    expect(page.items.map((i) => i.photos)).toEqual([
      ["https://img.example/a.jpg", "https://img.example/b.jpg"],
      [],
      [],
    ]);
  });

  it("#167: selects the capped, de-duplicated photo union via a single correlated subquery — no follow-up query per card", async () => {
    await listCandidates(7);
    const [sql] = mainCall();
    // One query total for the page (asserted structurally: the call count
    // for the main SELECT is exactly 1, same assertion style as the
    // "queries profile_listing_state..." test above) — the photo union lives
    // inside that one query's SELECT list, not a second round trip.
    expect(sql).toContain("AS photos");
    expect(sql).toContain("DISTINCT ON (photo_url)");
    // #167 review must-fix 2: the per-listing LATERAL LIMITs to
    // MAX_CARD_PHOTOS with no ORDER BY inside it (relying on unnest WITH
    // ORDINALITY's guaranteed already-ordered output) — this is what bounds
    // cost per listing instead of unnesting every photo of every active
    // listing before capping. Assert the shape structurally rather than the
    // full SQL text so the query can still be reformatted freely.
    expect(sql).toContain("unnest(array_remove(l4.photo_urls, NULL))");
    expect(sql).toContain("WITH ORDINALITY AS uu(photo_url, ord)");
    expect(sql).toMatch(/WITH ORDINALITY AS uu\(photo_url, ord\)\s*\n\s*LIMIT/);
    // #425: resolve + the single main page query (empty page → no loadFlags).
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });
});

describe("flagsFromAssessments (#152 review, must-fix 1 and 3)", () => {
  function assessmentRow(
    propertyId: number,
    result: Record<string, unknown> | null,
  ): RawAssessmentRow {
    return { property_id: propertyId, result };
  }

  it("returns no flags when a row has no caveats and no condition", () => {
    expect(flagsFromAssessments([assessmentRow(1, { caveats: [] })])).toEqual(
      [],
    );
    expect(flagsFromAssessments([assessmentRow(1, {})])).toEqual([]);
    expect(flagsFromAssessments([assessmentRow(1, null)])).toEqual([]);
  });

  it("maps every recognised caveat code to its warn-toned Spanish label", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, { caveats: ["tenanted", "venta_deuda", "proindiviso"] }),
    ]);
    expect(flags).toEqual([
      { kind: "caveat:tenanted", label: "Alquilado", tone: "warn" },
      { kind: "caveat:venta_deuda", label: "Venta de deuda", tone: "warn" },
      { kind: "caveat:proindiviso", label: "Proindiviso", tone: "warn" },
    ]);
  });

  it("must-fix 3: drops an unrecognised caveat code rather than rendering it as raw text", () => {
    // Simulates a vocabulary drift between the writer (occupancy.ts's
    // CAVEAT_CODES) and this file's CAVEAT_LABELS — e.g. a future axis value
    // this file hasn't been taught to label yet. Must be dropped, not shown
    // verbatim: unlike the old occupancy/sale_type fallback (`?? occupancy`),
    // a badge must never surface an unbounded string.
    const flags = flagsFromAssessments([
      assessmentRow(1, { caveats: ["some_future_unmapped_code", "tenanted"] }),
    ]);
    expect(flags).toEqual([
      { kind: "caveat:tenanted", label: "Alquilado", tone: "warn" },
    ]);
  });

  it("must-fix 3: drops an unrecognised condition value the same way condition already handled unknowns", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "unknown" })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "some_new_value" })]),
    ).toEqual([]);
  });

  it("maps a recognised condition value to a neutral-toned label", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar" })]),
    ).toEqual([
      { kind: "condition:a_reformar", label: "A reformar", tone: "neutral" },
    ]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "obra_nueva" })]),
    ).toEqual([
      { kind: "condition:obra_nueva", label: "Obra nueva", tone: "neutral" },
    ]);
  });

  it("refines the `a_reformar` badge with renovation severity when present (#313)", () => {
    expect(
      flagsFromAssessments([
        assessmentRow(1, {
          condition: "a_reformar",
          renovation_severity: "integral",
        }),
      ]),
    ).toEqual([
      {
        kind: "condition:a_reformar:integral",
        label: "A reformar (integral)",
        tone: "neutral",
      },
    ]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, {
          condition: "a_reformar",
          renovation_severity: "leve",
        }),
      ]),
    ).toEqual([
      {
        kind: "condition:a_reformar:leve",
        label: "A reformar (leve)",
        tone: "neutral",
      },
    ]);
  });

  it("keeps the plain `a_reformar` badge for ungraded/absent severity — backward compatible with pre-#313 rows", () => {
    // A row written before #313 has no renovation_severity field; `unknown`
    // (needs work, depth ungraded) and a stray null carry no extra info. All
    // three must render exactly the pre-#313 badge, kind included.
    const plain = {
      kind: "condition:a_reformar",
      label: "A reformar",
      tone: "neutral",
    };
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar" })]),
    ).toEqual([plain]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, {
          condition: "a_reformar",
          renovation_severity: "unknown",
        }),
      ]),
    ).toEqual([plain]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, {
          condition: "a_reformar",
          renovation_severity: null,
        }),
      ]),
    ).toEqual([plain]);
  });

  it("does not refine obra_nueva with a stray severity value (#313 — refinement is scoped to a_reformar)", () => {
    expect(
      flagsFromAssessments([
        assessmentRow(1, {
          condition: "obra_nueva",
          renovation_severity: "integral",
        }),
      ]),
    ).toEqual([
      { kind: "condition:obra_nueva", label: "Obra nueva", tone: "neutral" },
    ]);
  });

  it("gives no badge to the unremarkable condition default or the no-info value (#26)", () => {
    // Same rule as occupancy's `pleno_dominio`: the ordinary/default case and
    // "we don't know" are not findings, so neither gets a badge.
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "reformado" })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "unclear" })]),
    ).toEqual([]);
  });

  it("ignores non-array/non-string caveats defensively rather than throwing", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { caveats: "not-an-array" })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, { caveats: [42, null, "tenanted"] }),
      ]),
    ).toEqual([{ kind: "caveat:tenanted", label: "Alquilado", tone: "warn" }]);
  });

  it("#361: maps redflags `flags` to warn-toned badges carrying the model's description as a tooltip", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, {
        flags: [
          {
            type: "unfinished_construction",
            description: "Comprobar cuánto falta por terminar la obra.",
            evidence: "inmueble en construcción, parcialmente ejecutada",
            evidence_source: "idealista",
          },
          {
            type: "embargo",
            description: "Verificar la existencia de un embargo.",
            evidence: "con embargo pendiente",
          },
        ],
      }),
    ]);
    expect(flags).toEqual([
      {
        kind: "redflag:unfinished_construction",
        label: "Obra inacabada",
        tone: "warn",
        description: "Comprobar cuánto falta por terminar la obra.",
      },
      {
        kind: "redflag:embargo",
        label: "Embargo",
        tone: "warn",
        description: "Verificar la existencia de un embargo.",
      },
    ]);
  });

  it("#361: drops the `other` catch-all and any unmapped redflag type rather than rendering raw text", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, {
        flags: [
          { type: "other", description: "algo raro", evidence: "cita" },
          { type: "some_future_type", description: "x", evidence: "y" },
          {
            type: "litigio",
            description: "Hay litigio.",
            evidence: "procedimiento judicial en curso",
          },
        ],
      }),
    ]);
    expect(flags).toEqual([
      {
        kind: "redflag:litigio",
        label: "Litigio",
        tone: "warn",
        description: "Hay litigio.",
      },
    ]);
  });

  it("#361: a redflag badge with no/blank description omits the tooltip field rather than carrying an empty string", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, {
        flags: [
          {
            type: "structural_damage",
            description: "  ",
            evidence: "grietas estructurales",
          },
        ],
      }),
    ]);
    expect(flags).toEqual([
      {
        kind: "redflag:structural_damage",
        label: "Daño estructural",
        tone: "warn",
      },
    ]);
  });

  it("#361: ignores a non-array `flags` value defensively rather than throwing", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { flags: "ninguna" })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([assessmentRow(1, { flags: [42, null] })]),
    ).toEqual([]);
  });

  it("de-dups by kind when given multiple rows that both produce the same flag (defence in depth on top of loadFlags's DISTINCT ON)", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, { caveats: ["tenanted"] }),
      assessmentRow(1, { caveats: ["tenanted"] }),
    ]);
    expect(flags).toHaveLength(1);
  });

  it("does NOT collapse two different verdicts on the same axis — different caveat codes stay distinct flags (this is exactly what loadFlags's SQL, not this function, is responsible for preventing)", () => {
    // Mirrors the #152 review's reproduction: "Alquilado" and "Ocupado"
    // simultaneously. flagsFromAssessments alone cannot fix this — it only
    // dedups identical `kind`s — which is precisely why the real fix has to
    // be loadFlags's `DISTINCT ON (property_id, assessment_type)` selecting
    // a single row per axis *before* this function ever sees the data.
    const flags = flagsFromAssessments([
      assessmentRow(1, { caveats: ["tenanted"] }),
      assessmentRow(1, { caveats: ["occupied_illegally"] }),
    ]);
    expect(flags.map((f) => f.kind).sort()).toEqual([
      "caveat:occupied_illegally",
      "caveat:tenanted",
    ]);
  });

  // #388 location axis: graded beach proximity + heritage_zone boolean.
  it("#388: maps each graded beach_proximity value to its neutral Spanish badge", () => {
    expect(
      flagsFromAssessments([
        assessmentRow(1, { beach_proximity: "frontline" }),
      ]),
    ).toEqual([
      {
        kind: "location:beach:frontline",
        label: "Primera línea",
        tone: "neutral",
      },
    ]);
    expect(
      flagsFromAssessments([assessmentRow(1, { beach_proximity: "sea_view" })]),
    ).toEqual([
      {
        kind: "location:beach:sea_view",
        label: "Vistas al mar",
        tone: "neutral",
      },
    ]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, { beach_proximity: "near_beach" }),
      ]),
    ).toEqual([
      {
        kind: "location:beach:near_beach",
        label: "Cerca playa",
        tone: "neutral",
      },
    ]);
  });

  it("#388: emits no badge for beach_proximity `none` or an unmapped value", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { beach_proximity: "none" })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([
        assessmentRow(1, { beach_proximity: "some_new_grade" }),
      ]),
    ).toEqual([]);
  });

  it("#388: emits the `Casco histórico` badge only when heritage_zone is strictly true", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { heritage_zone: true })]),
    ).toEqual([
      {
        kind: "location:heritage_zone",
        label: "Casco histórico",
        tone: "neutral",
      },
    ]);
    expect(
      flagsFromAssessments([assessmentRow(1, { heritage_zone: false })]),
    ).toEqual([]);
    // Defensive: a truthy-but-not-`true` value must not manufacture a badge.
    expect(
      flagsFromAssessments([assessmentRow(1, { heritage_zone: "true" })]),
    ).toEqual([]);
  });

  it("#388: a beachfront property in the casco histórico shows both location badges", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, { beach_proximity: "frontline", heritage_zone: true }),
    ]);
    expect(flags).toEqual([
      {
        kind: "location:beach:frontline",
        label: "Primera línea",
        tone: "neutral",
      },
      {
        kind: "location:heritage_zone",
        label: "Casco histórico",
        tone: "neutral",
      },
    ]);
  });

  // #398 opportunity axis: is_vpo (warn) + tourist_license (neutral) badges.
  it("#398: emits the warn-tone `VPO` badge only when is_vpo is strictly true", () => {
    expect(flagsFromAssessments([assessmentRow(1, { is_vpo: true })])).toEqual([
      { kind: "opportunity:is_vpo", label: "VPO", tone: "warn" },
    ]);
    expect(flagsFromAssessments([assessmentRow(1, { is_vpo: false })])).toEqual(
      [],
    );
    // Defensive: a truthy-but-not-`true` value must not manufacture a badge.
    expect(
      flagsFromAssessments([assessmentRow(1, { is_vpo: "true" })]),
    ).toEqual([]);
  });

  it("#398: emits the neutral-tone `Licencia turística` badge only when tourist_license is strictly true", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { tourist_license: true })]),
    ).toEqual([
      {
        kind: "opportunity:tourist_license",
        label: "Licencia turística",
        tone: "neutral",
      },
    ]);
    expect(
      flagsFromAssessments([assessmentRow(1, { tourist_license: false })]),
    ).toEqual([]);
    expect(
      flagsFromAssessments([assessmentRow(1, { tourist_license: "true" })]),
    ).toEqual([]);
  });

  it("#398: a VPO with a granted tourist licence shows both opportunity badges", () => {
    const flags = flagsFromAssessments([
      assessmentRow(1, { is_vpo: true, tourist_license: true }),
    ]);
    expect(flags).toEqual([
      { kind: "opportunity:is_vpo", label: "VPO", tone: "warn" },
      {
        kind: "opportunity:tourist_license",
        label: "Licencia turística",
        tone: "neutral",
      },
    ]);
  });
});

describe("loadFlags SQL shape (#152 review, must-fix 1 and 2)", () => {
  it("selects the latest row per (property_id, assessment_type) via DISTINCT ON, ordered by generated_at DESC", async () => {
    // Triggered indirectly through listCandidates: the first mocked call
    // answers the main candidate query, the second answers loadFlags's own
    // query for the returned property id.
    queueMain({
      rows: [{ ...stubRow(7) }],
    });
    queueMain({ rows: [] });

    await listCandidates(1);

    // #425: resolve (novelty context) + main candidate query + loadFlags = 3.
    expect(mockPoolQuery).toHaveBeenCalledTimes(3);
    const [flagsSql, flagsParams] = flagsCall();
    expect(flagsSql).toContain("DISTINCT ON (property_id, assessment_type)");
    expect(flagsSql).toContain("FROM ai_assessment");
    expect(flagsSql).toContain("WHERE property_id = ANY($1::bigint[])");
    // #361: redflags joined occupancy/condition as a badge-producing axis.
    expect(flagsSql).toContain("'redflags'");
    expect(flagsSql).toContain(
      "ORDER BY property_id, assessment_type, generated_at DESC",
    );
    expect(flagsParams).toEqual([[7]]);
  });

  it("reads property_id directly — no listing_id probe query against information_schema (must-fix 2: the dual-shape probe was removed, not patched)", async () => {
    queueMain({ rows: [{ ...stubRow(3) }] });
    queueMain({ rows: [] });

    await listCandidates(1);

    // Scoped to the ai_assessment/loadFlags query specifically (found by its
    // `FROM ai_assessment`), not every call — #167's photo union legitimately
    // introduces its own unrelated `listing_id` alias (`l4.id AS listing_id`)
    // in the main candidates query to reconstruct visual photo order, which has
    // nothing to do with the stale ai_assessment shape probe this test guards
    // against.
    const [flagsSql] = flagsCall();
    expect(flagsSql).not.toContain("information_schema");
    expect(flagsSql).not.toContain("listing_id");
  });

  it("skips the ai_assessment query entirely when the page has no rows (nothing to flag)", async () => {
    queueMain({ rows: [] });
    await listCandidates(1);
    // #425: resolve + main only — no loadFlags call for an empty page.
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it("degrades to no flags (not a thrown error) when ai_assessment is unreadable", async () => {
    queueMain({ rows: [{ ...stubRow(7) }] });
    queueMain(new Error('relation "ai_assessment" does not exist'));

    const page = await listCandidates(1);
    expect(page.items[0].flags).toEqual([]);
  });
});

describe("getAdjacentCandidates", () => {
  it("returns null/null when the anchor property isn't a matched candidate for this profile", async () => {
    queueMain({ rows: [] }); // anchor lookup (after the resolve query)
    const result = await getAdjacentCandidates(1, 999);
    expect(result).toEqual({ prevPropertyId: null, nextPropertyId: null });
    // #425: the novelty-context resolve query + the anchor lookup run; no point
    // querying neighbours of a property that isn't in this profile's set.
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it("treats a NULL anchor effective_score as NO_SCORE_SENTINEL when comparing neighbours", async () => {
    // The anchor query now reads the blended `effective_score` + novelty_tier
    // from the ranked CTE (#309/#425); a never-scored, no-signal anchor comes
    // back null.
    queueMain({ rows: [{ novelty_tier: 0, effective_score: null }] });
    queueMain({ rows: [] }); // next
    queueMain({ rows: [] }); // prev

    await getAdjacentCandidates(1, 5);

    // #425 call order: resolve(0), anchor(1), next(2), prev(3).
    const nextParams = mockPoolQuery.mock.calls[2][1];
    const prevParams = mockPoolQuery.mock.calls[3][1];
    // anchorScore param (index 1) must be the -1 sentinel, not null/NaN —
    // otherwise the `< $2::double precision` comparison is unusable SQL-side.
    expect(nextParams[1]).toBe(-1);
    expect(prevParams[1]).toBe(-1);
  });

  it("returns null for a side with no neighbour (top/bottom of the ranking) while still returning the other side", async () => {
    queueMain({ rows: [{ novelty_tier: 1, effective_score: "0.91" }] }); // anchor
    queueMain({ rows: [] }); // no next (top of ranking)
    queueMain({ rows: [{ property_id: 3 }] }); // prev exists

    const result = await getAdjacentCandidates(1, 5);
    expect(result.nextPropertyId).toBeNull();
    expect(result.prevPropertyId).toBe(3);
  });

  it("neighbour property_id (a pg bigint) reaches the caller as a real number", async () => {
    // See the "property_id ... real JSON number" test above: the mocked
    // `pg` module bypasses the driver-level int8 type parser (db-shared.ts,
    // #155) that now guarantees this in production, so the mock supplies
    // the already-parsed number directly — this is a pass-through guard on
    // getAdjacentCandidates, not a test of the coercion itself.
    queueMain({ rows: [{ novelty_tier: 0, effective_score: "0.5" }] });
    queueMain({ rows: [{ property_id: 42 }] });
    queueMain({ rows: [{ property_id: 7 }] });

    const result = await getAdjacentCandidates(1, 5);
    expect(result.nextPropertyId).toBe(42);
    expect(typeof result.nextPropertyId).toBe("number");
    expect(result.prevPropertyId).toBe(7);
  });

  it("#425: reuses listCandidates's exact 3-column keyset ordering — (novelty_tier, effective_score, property_id) — so prev/next never desyncs from the feed", async () => {
    queueMain({ rows: [{ novelty_tier: 1, effective_score: "0.5" }] });
    queueMain({ rows: [] });
    queueMain({ rows: [] });

    await getAdjacentCandidates(1, 5);

    // #425 call order: resolve(0), anchor(1), next(2), prev(3).
    const [nextSql] = mockPoolQuery.mock.calls[2];
    const [prevSql] = mockPoolQuery.mock.calls[3];
    // "next" (ranked worse) sorts DESC and compares strictly-less-than the
    // anchor on the SAME 3-column key the feed uses — tier leads, then the
    // blended effective_score (#309), then id.
    expect(nextSql).toContain(
      "ORDER BY novelty_tier DESC, effective_score DESC, property_id DESC",
    );
    expect(nextSql).toContain("novelty_tier < $6::int");
    expect(nextSql).toContain("< $2::double precision");
    // "prev" (ranked better) reverses the sort and every comparison direction.
    expect(prevSql).toContain(
      "ORDER BY novelty_tier ASC, effective_score ASC, property_id ASC",
    );
    expect(prevSql).toContain("novelty_tier > $6::int");
    expect(prevSql).toContain("> $2::double precision");
  });
});

describe("classifyPriceChange (#420 sanity band)", () => {
  // Defaults as fractions: 1% .. 60%.
  const MIN = 0.01;
  const MAX = 0.6;

  it("badges a mid-range drop as BAJADA (direction 'drop')", () => {
    expect(classifyPriceChange(-0.086, MIN, MAX)).toEqual({
      price_changed: true,
      price_delta_pct: -0.086,
      price_direction: "drop",
    });
  });

  it("badges a mid-range rise as SUBIDA (direction 'up')", () => {
    expect(classifyPriceChange(0.077, MIN, MAX)).toEqual({
      price_changed: true,
      price_delta_pct: 0.077,
      price_direction: "up",
    });
  });

  it("does NOT badge a just-under-1% move (noise) but keeps the raw delta", () => {
    expect(classifyPriceChange(-0.009, MIN, MAX)).toEqual({
      price_changed: false,
      price_delta_pct: -0.009,
      price_direction: null,
    });
  });

  it("does NOT badge a just-over-60% move (suspect) but keeps the raw delta for data-health", () => {
    expect(classifyPriceChange(-0.62, MIN, MAX)).toEqual({
      price_changed: false,
      price_delta_pct: -0.62,
      price_direction: null,
    });
    // The demo's −96% artifact — excluded from the badge, delta preserved.
    expect(classifyPriceChange(-0.96, MIN, MAX)).toMatchObject({
      price_changed: false,
    });
  });

  it("treats both band edges as inclusive (exactly 1% and exactly 60% badge)", () => {
    expect(classifyPriceChange(0.01, MIN, MAX).price_changed).toBe(true);
    expect(classifyPriceChange(-0.6, MIN, MAX).price_changed).toBe(true);
  });

  it("returns a clean no-change signal for null / non-finite input", () => {
    expect(classifyPriceChange(null, MIN, MAX)).toEqual({
      price_changed: false,
      price_delta_pct: null,
      price_direction: null,
    });
    expect(classifyPriceChange(Number.NaN, MIN, MAX).price_changed).toBe(false);
  });
});

describe("describeRankingBoost (#309)", () => {
  it("returns null when there is no notable signal (graceful — no placeholder)", () => {
    expect(describeRankingBoost(null, 0)).toBeNull();
    // A discount below the notable threshold is noise, not a "deal".
    expect(describeRankingBoost(0.02, 0)).toBeNull();
    // An at/above-market (negative discount) property is not a below-market signal.
    expect(describeRankingBoost(-0.3, 0)).toBeNull();
  });

  it("names the below-market discount as a rounded percentage when notable", () => {
    const reason = describeRankingBoost(0.23, 0);
    expect(reason).toContain("23%");
    expect(reason).toContain("por debajo de la mediana");
    expect(reason).toMatch(/^Destacado:/);
  });

  it("names distress when at least one axis is flagged", () => {
    const reason = describeRankingBoost(null, 2);
    expect(reason).toContain("señales de oportunidad");
    expect(reason).toMatch(/^Destacado:/);
  });

  it("combines both signals in one explanation when both are present", () => {
    const reason = describeRankingBoost(0.31, 1)!;
    expect(reason).toContain("31%");
    expect(reason).toContain("señales de oportunidad");
    // Both clauses, semicolon-joined, single sentence.
    expect(reason.split(";")).toHaveLength(2);
    expect(reason.endsWith(".")).toBe(true);
  });

  it("names beach proximity as a boost reason for a positive grade (#392)", () => {
    const frontline = describeRankingBoost(null, 0, "frontline")!;
    expect(frontline).toContain("proximidad a la playa");
    expect(frontline.toLowerCase()).toContain("primera línea");
    expect(describeRankingBoost(null, 0, "sea_view")).toContain(
      "vistas al mar",
    );
    // `none`/null/unmapped carry no boost, so no reason clause (and a default
    // arg keeps every existing 2-arg caller unchanged).
    expect(describeRankingBoost(null, 0, "none")).toBeNull();
    expect(describeRankingBoost(null, 0, null)).toBeNull();
  });

  it("joins the beach reason with the other signals as a third clause (#392)", () => {
    const reason = describeRankingBoost(0.2, 1, "sea_view")!;
    expect(reason.split(";")).toHaveLength(3);
    expect(reason).toContain("20%");
    expect(reason).toContain("señales de oportunidad");
    expect(reason).toContain("proximidad a la playa");
  });

  it("names a granted tourist licence as a boost reason, but never is_vpo (#398)", () => {
    const withLicence = describeRankingBoost(null, 0, null, true)!;
    expect(withLicence).toContain("licencia turística concedida");
    // Absent licence carries no boost, so no clause; default arg keeps every
    // existing 3-arg caller unchanged.
    expect(describeRankingBoost(null, 0, null, false)).toBeNull();
    expect(describeRankingBoost(null, 0, null)).toBeNull();
  });

  it("joins the tourist-licence reason with the other signals as a fourth clause (#398)", () => {
    const reason = describeRankingBoost(0.2, 1, "sea_view", true)!;
    expect(reason.split(";")).toHaveLength(4);
    expect(reason).toContain("licencia turística concedida");
  });

  it("names a long time on market as a boost reason (#452)", () => {
    const reason = describeRankingBoost(null, 0, null, false, 120, null)!;
    expect(reason).toContain("120 días en el mercado");
    // A fresh listing (below the notable threshold) earns no clause.
    expect(describeRankingBoost(null, 0, null, false, 10, null)).toBeNull();
    // Default args keep every existing 4-arg caller unchanged.
    expect(describeRankingBoost(null, 0, null, false)).toBeNull();
  });

  it("names a cumulative price drop as a boost reason (#452)", () => {
    const reason = describeRankingBoost(null, 0, null, false, null, 0.12)!;
    expect(reason).toContain("bajado ~12%");
    // A negligible drop earns no clause; a rise (negative) never does.
    expect(describeRankingBoost(null, 0, null, false, null, 0.02)).toBeNull();
    expect(describeRankingBoost(null, 0, null, false, null, -0.1)).toBeNull();
  });

  it("joins the timing reasons after the opportunity ones (#452)", () => {
    const reason = describeRankingBoost(0.2, 1, "sea_view", true, 120, 0.12)!;
    // below-market ; distress ; beach ; tourist ; days ; drop = 6 clauses.
    expect(reason.split(";")).toHaveLength(6);
    expect(reason).toContain("días en el mercado");
    expect(reason).toContain("bajado ~12%");
  });
});

describe("cursor encode/decode (#425 3-column keyset + threaded context)", () => {
  it("round-trips the 5-element payload (tier, score, id, anchorTs, coldStart) via nextCursor", async () => {
    // A fresh (tier 1) top row followed by a tier-0 row, limit 1 → a next page
    // exists, so nextCursor carries the LAST kept row's tier + score + id, plus
    // the session-fixed anchor + cold-start decision resolved on page 1.
    queueMain({
      rows: [
        {
          ...stubRow(2),
          novelty_tier: 1,
          score: "0.9",
          effective_score: "0.9",
        },
        {
          ...stubRow(9),
          novelty_tier: 0,
          score: "0.5",
          effective_score: "0.5",
        },
      ],
    });
    const page = await listCandidates(1, { limit: 1 });
    expect(page.items.map((i) => i.property_id)).toEqual([2]);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      tier: 1,
      score: 0.9,
      id: 2,
      anchorTs: FIXED_ANCHOR,
      coldStart: false,
    });
  });

  it("rejects a legacy 2-element cursor — the sort key changed, so it can't resume the new scan", () => {
    const legacy = Buffer.from(JSON.stringify([0.5, 42])).toString("base64url");
    expect(decodeCursor(legacy)).toBeNull();
  });

  it("rejects a 5-element cursor with a non-integer tier, an unparseable anchor, or a non-boolean coldStart", () => {
    const badTier = Buffer.from(
      JSON.stringify([0.5, 0.5, 42, FIXED_ANCHOR, false]),
    ).toString("base64url");
    const badAnchor = Buffer.from(
      JSON.stringify([1, 0.5, 42, "not-a-date", false]),
    ).toString("base64url");
    const badCold = Buffer.from(
      JSON.stringify([1, 0.5, 42, FIXED_ANCHOR, "nope"]),
    ).toString("base64url");
    expect(decodeCursor(badTier)).toBeNull();
    expect(decodeCursor(badAnchor)).toBeNull();
    expect(decodeCursor(badCold)).toBeNull();
  });

  it("accepts a well-formed 5-element cursor", () => {
    const ok = Buffer.from(
      JSON.stringify([1, 0.42, 7, FIXED_ANCHOR, true]),
    ).toString("base64url");
    expect(decodeCursor(ok)).toEqual({
      tier: 1,
      score: 0.42,
      id: 7,
      anchorTs: FIXED_ANCHOR,
      coldStart: true,
    });
  });

  it("threads the decoded cursor's tier + anchor + cold-start back into the page query, and does NOT re-resolve", async () => {
    await listCandidates(1, {
      cursor: testCursor(0.5, 9, 1, FIXED_ANCHOR, true),
    });
    // Page 2 issues NO resolve query — the resolve query is a page-1-only cost.
    expect(mockPoolQuery.mock.calls.some(([s]) => isResolveSql(s))).toBe(false);
    const params = mainParams();
    // $19 tier, $20 anchor, $23 cold-start all come from the cursor.
    expect(params[18]).toBe(1); // cursorTier ($19)
    expect(params[19]).toBe(FIXED_ANCHOR); // anchorTs ($20)
    expect(params[22]).toBe(true); // coldStart ($23)
    // The 3-column keyset WHERE compares on novelty_tier first.
    const [sql] = mainCall();
    expect(sql).toContain("ranked.novelty_tier < $19::int");
  });
});

describe("#425 cold-start novelty-tier suppression", () => {
  it("computes the leading novelty_tier INSIDE the ranked CTE with the tracked-exempt cold-start guard, never in effective_score", async () => {
    await listCandidates(7);
    const [sql] = mainCall();
    // Tier derived once in the CTE (all three call sites inherit it), separate
    // from effective_score, and cold-start never suppresses a tracked (accept) row.
    expect(sql).toContain("AS novelty_tier");
    expect(sql).toContain("base.feedback_state IS DISTINCT FROM 'accept'");
    // effective_score expression is unchanged — novelty is NOT folded into it.
    expect(sql).not.toMatch(/novelty_tier[^\n]*AS effective_score/);
  });

  it("suppresses the tier (page.coldStart true, $23 true) when the fresh coverage exceeds the 60% default", async () => {
    // 429 of 431 fresh — the plan's profile-347 flood (>60%).
    resolveRow = {
      anchor_ts: FIXED_ANCHOR,
      never_visited: false,
      total: 431,
      fresh: 429,
    };
    const page = await listCandidates(7);
    expect(page.coldStart).toBe(true);
    expect(mainParams()[22]).toBe(true); // coldStart threaded into the page query ($23)
  });

  it("suppresses the tier when the profile was never visited, regardless of coverage", async () => {
    resolveRow = {
      anchor_ts: FIXED_ANCHOR,
      never_visited: true,
      total: 431,
      fresh: 1,
    };
    const page = await listCandidates(7);
    expect(page.coldStart).toBe(true);
    expect(mainParams()[22]).toBe(true);
  });

  it("does NOT suppress when a visited profile's fresh coverage is under the threshold", async () => {
    resolveRow = {
      anchor_ts: FIXED_ANCHOR,
      never_visited: false,
      total: 100,
      fresh: 10,
    };
    const page = await listCandidates(7);
    expect(page.coldStart).toBe(false);
    expect(mainParams()[22]).toBe(false);
  });

  it("does NOT divide by zero on an empty matched pool (coverage 0 → no suppression)", async () => {
    resolveRow = {
      anchor_ts: FIXED_ANCHOR,
      never_visited: false,
      total: 0,
      fresh: 0,
    };
    const page = await listCandidates(7);
    expect(page.coldStart).toBe(false);
  });
});
