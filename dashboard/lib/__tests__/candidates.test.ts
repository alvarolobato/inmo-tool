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
// min-below-market ($11). This is the "all filters off" tail every existing
// listCandidates assertion carries now.
const NO_FILTER_TAIL = [null, OCCUPIED_STATUSES, null, null, null] as const;

/** Builds a cursor the same way `listCandidates` does internally, purely for test setup — tests otherwise treat cursors as opaque and decode `nextCursor` to assert on it. */
function testCursor(score: number | null, id: number): string {
  return Buffer.from(JSON.stringify([score ?? -1, id])).toString("base64url");
}

// File-scoped (not nested in one describe) so every describe block below
// gets a freshly-reset mock and pool — the loadFlags/getAdjacentCandidates
// suites added for the #152 review need this exactly as much as
// listCandidates's own tests do; nesting it inside `describe("listCandidates"`
// only would leave sibling describes sharing mock state across tests.
beforeEach(async () => {
  mockPoolQuery.mockReset();
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
});

describe("listCandidates", () => {
  it("queries profile_listing_state joined to property, filtered on matched=true", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await listCandidates(7);

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0];
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
    expect(params).toEqual([7, null, null, 31, null, WARN_CAVEAT_CODES, ...NO_FILTER_TAIL]);
  });

  it("passes the decoded cursor and clamps limit to [1, 100] (querying limit+1 rows)", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await listCandidates(7, { cursor: testCursor(0.73, 42), limit: 500 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, 0.73, 42, 101, null, WARN_CAVEAT_CODES, ...NO_FILTER_TAIL]);

    mockPoolQuery.mockClear();
    await listCandidates(7, { limit: 0 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, null, null, 2, null, WARN_CAVEAT_CODES, ...NO_FILTER_TAIL]);
  });

  it("passes a trimmed source as $5 and adds the portal EXISTS filter (#265)", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await listCandidates(7, { source: "  idealista  " });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    // Trimmed, and the EXISTS subquery gates on the same active+sale set the
    // card's badges use.
    expect(params).toEqual([7, null, null, 31, "idealista", WARN_CAVEAT_CODES, ...NO_FILTER_TAIL]);
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("lf.source = $5");

    // An empty / whitespace-only source is "no filter" — $5 stays null.
    mockPoolQuery.mockClear();
    await listCandidates(7, { source: "   " });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, null, null, 31, null, WARN_CAVEAT_CODES, ...NO_FILTER_TAIL]);
  });

  it("rejects a malformed cursor rather than silently resetting to page 1", async () => {
    await expect(listCandidates(7, { cursor: "not-valid-base64-json" })).rejects.toThrow(
      "Cursor no válido.",
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("sets nextCursor only when a real next page exists (extra row is fetched and trimmed, not inferred from a full page)", async () => {
    // limit=2, DB returns 3 rows (limit+1) => a real next page exists.
    mockPoolQuery.mockResolvedValueOnce({ rows: [stubRow(3), stubRow(2), stubRow(1)] });
    const withMore = await listCandidates(1, { limit: 2 });
    expect(withMore.items).toHaveLength(2);
    expect(withMore.items.map((i) => i.property_id)).toEqual([3, 2]);
    // Cursor is opaque to callers — decode it to assert on its meaning
    // (resume after the last row actually returned, id=2, score=null here).
    expect(decodeCursor(withMore.nextCursor!)).toEqual({ score: -1, id: 2 });

    // limit=2, DB returns exactly 2 rows (no extra row) => this genuinely is
    // the last page, even though it's "full" — the bug this test guards
    // against previously showed a dead "Cargar más" here.
    mockPoolQuery.mockResolvedValueOnce({ rows: [stubRow(3), stubRow(2)] });
    const exactlyFull = await listCandidates(1, { limit: 2 });
    expect(exactlyFull.items).toHaveLength(2);
    expect(exactlyFull.nextCursor).toBeNull();

    // limit=2, DB returns 1 row => partial page, no next page.
    mockPoolQuery.mockResolvedValueOnce({ rows: [stubRow(3)] });
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
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...stubRow(0), property_id: 179 }],
    });
    const page = await listCandidates(1);
    expect(page.items[0].property_id).toBe(179);
    expect(typeof page.items[0].property_id).toBe("number");
  });

  it("groups a property's multiple listings under one row (one card per property, not per listing)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
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
          rank_explanation: "Encaja bien con tu perfil: precio un 8% por debajo de tu banda de precio.",
          listings: [
            { id: 10, source: "fotocasa", url: "https://fotocasa.example/10", current_price: 285000 },
            { id: 11, source: "milanuncios", url: "https://milanuncios.example/11", current_price: 279000 },
          ],
        },
      ],
    });

    const page = await listCandidates(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].property_id).toBe(5);
    expect(page.items[0].listings.map((l) => l.source).sort()).toEqual(["fotocasa", "milanuncios"]);
    // Numeric columns come back as strings from pg for NUMERIC types — must
    // be coerced, not left as strings the UI would render/sort incorrectly.
    expect(page.items[0].lat).toBe(40.4324);
    expect(page.items[0].m2_built).toBe(70);
    expect(page.items[0].min_price).toBe(279000);
  });

  it("coerces score (a pg NUMERIC, returned as a string) to a JSON number, and passes rank_explanation through untouched", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...stubRow(1), score: "0.500", rank_explanation: "Sin motivos concretos que destacar todavía para este candidato." }],
    });
    const page = await listCandidates(1);
    expect(page.items[0].score).toBe(0.5);
    expect(typeof page.items[0].score).toBe("number");
    expect(page.items[0].rank_explanation).toBe("Sin motivos concretos que destacar todavía para este candidato.");
  });

  it("leaves score and rank_explanation null when the property hasn't been scored yet", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [stubRow(1)] });
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
    mockPoolQuery.mockResolvedValueOnce({
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
    expect(decodeCursor(page.nextCursor!)).toEqual({ score: 0.5, id: 9 });
  });

  it("coerces score_kind through, and defaults to null when the DB returns it undefined (older mocked rows)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...stubRow(1), score_kind: "trained" }, { ...stubRow(2), score_kind: null }, stubRow(3)],
    });
    const page = await listCandidates(1);
    expect(page.items.map((i) => i.score_kind)).toEqual(["trained", null, null]);
  });

  it("#167: passes the photos array through, defaulting to [] when the DB returns it undefined (older mocked rows)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { ...stubRow(1), photos: ["https://img.example/a.jpg", "https://img.example/b.jpg"] },
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
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await listCandidates(7);
    const [sql] = mockPoolQuery.mock.calls[0];
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
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

describe("flagsFromAssessments (#152 review, must-fix 1 and 3)", () => {
  function assessmentRow(propertyId: number, result: Record<string, unknown> | null): RawAssessmentRow {
    return { property_id: propertyId, result };
  }

  it("returns no flags when a row has no caveats and no condition", () => {
    expect(flagsFromAssessments([assessmentRow(1, { caveats: [] })])).toEqual([]);
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
    expect(flags).toEqual([{ kind: "caveat:tenanted", label: "Alquilado", tone: "warn" }]);
  });

  it("must-fix 3: drops an unrecognised condition value the same way condition already handled unknowns", () => {
    expect(flagsFromAssessments([assessmentRow(1, { condition: "unknown" })])).toEqual([]);
    expect(flagsFromAssessments([assessmentRow(1, { condition: "some_new_value" })])).toEqual([]);
  });

  it("maps a recognised condition value to a neutral-toned label", () => {
    expect(flagsFromAssessments([assessmentRow(1, { condition: "a_reformar" })])).toEqual([
      { kind: "condition:a_reformar", label: "A reformar", tone: "neutral" },
    ]);
    expect(flagsFromAssessments([assessmentRow(1, { condition: "obra_nueva" })])).toEqual([
      { kind: "condition:obra_nueva", label: "Obra nueva", tone: "neutral" },
    ]);
  });

  it("refines the `a_reformar` badge with renovation severity when present (#313)", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar", renovation_severity: "integral" })]),
    ).toEqual([{ kind: "condition:a_reformar:integral", label: "A reformar (integral)", tone: "neutral" }]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar", renovation_severity: "leve" })]),
    ).toEqual([{ kind: "condition:a_reformar:leve", label: "A reformar (leve)", tone: "neutral" }]);
  });

  it("keeps the plain `a_reformar` badge for ungraded/absent severity — backward compatible with pre-#313 rows", () => {
    // A row written before #313 has no renovation_severity field; `unknown`
    // (needs work, depth ungraded) and a stray null carry no extra info. All
    // three must render exactly the pre-#313 badge, kind included.
    const plain = { kind: "condition:a_reformar", label: "A reformar", tone: "neutral" };
    expect(flagsFromAssessments([assessmentRow(1, { condition: "a_reformar" })])).toEqual([plain]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar", renovation_severity: "unknown" })]),
    ).toEqual([plain]);
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "a_reformar", renovation_severity: null })]),
    ).toEqual([plain]);
  });

  it("does not refine obra_nueva with a stray severity value (#313 — refinement is scoped to a_reformar)", () => {
    expect(
      flagsFromAssessments([assessmentRow(1, { condition: "obra_nueva", renovation_severity: "integral" })]),
    ).toEqual([{ kind: "condition:obra_nueva", label: "Obra nueva", tone: "neutral" }]);
  });

  it("gives no badge to the unremarkable condition default or the no-info value (#26)", () => {
    // Same rule as occupancy's `pleno_dominio`: the ordinary/default case and
    // "we don't know" are not findings, so neither gets a badge.
    expect(flagsFromAssessments([assessmentRow(1, { condition: "reformado" })])).toEqual([]);
    expect(flagsFromAssessments([assessmentRow(1, { condition: "unclear" })])).toEqual([]);
  });

  it("ignores non-array/non-string caveats defensively rather than throwing", () => {
    expect(flagsFromAssessments([assessmentRow(1, { caveats: "not-an-array" })])).toEqual([]);
    expect(flagsFromAssessments([assessmentRow(1, { caveats: [42, null, "tenanted"] })])).toEqual([
      { kind: "caveat:tenanted", label: "Alquilado", tone: "warn" },
    ]);
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
    expect(flags.map((f) => f.kind).sort()).toEqual(["caveat:occupied_illegally", "caveat:tenanted"]);
  });
});

describe("loadFlags SQL shape (#152 review, must-fix 1 and 2)", () => {
  it("selects the latest row per (property_id, assessment_type) via DISTINCT ON, ordered by generated_at DESC", async () => {
    // Triggered indirectly through listCandidates: the first mocked call
    // answers the main candidate query, the second answers loadFlags's own
    // query for the returned property id.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...stubRow(7) }],
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await listCandidates(1);

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const [flagsSql, flagsParams] = mockPoolQuery.mock.calls[1];
    expect(flagsSql).toContain("DISTINCT ON (property_id, assessment_type)");
    expect(flagsSql).toContain("FROM ai_assessment");
    expect(flagsSql).toContain("WHERE property_id = ANY($1::bigint[])");
    expect(flagsSql).toContain("ORDER BY property_id, assessment_type, generated_at DESC");
    expect(flagsParams).toEqual([[7]]);
  });

  it("reads property_id directly — no listing_id probe query against information_schema (must-fix 2: the dual-shape probe was removed, not patched)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...stubRow(3) }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await listCandidates(1);

    // Scoped to the ai_assessment/loadFlags query specifically (call index
    // 1), not every call — #167's photo union legitimately introduces its
    // own unrelated `listing_id` alias (`l4.id AS listing_id`) in the main
    // candidates query (call index 0) to reconstruct visual photo order,
    // which has nothing to do with the stale ai_assessment shape probe this
    // test guards against.
    const [flagsSql] = mockPoolQuery.mock.calls[1];
    expect(flagsSql).not.toContain("information_schema");
    expect(flagsSql).not.toContain("listing_id");
  });

  it("skips the ai_assessment query entirely when the page has no rows (nothing to flag)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await listCandidates(1);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("degrades to no flags (not a thrown error) when ai_assessment is unreadable", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...stubRow(7) }] });
    mockPoolQuery.mockRejectedValueOnce(new Error("relation \"ai_assessment\" does not exist"));

    const page = await listCandidates(1);
    expect(page.items[0].flags).toEqual([]);
  });
});

describe("getAdjacentCandidates", () => {
  it("returns null/null when the anchor property isn't a matched candidate for this profile", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getAdjacentCandidates(1, 999);
    expect(result).toEqual({ prevPropertyId: null, nextPropertyId: null });
    // Only the anchor lookup should run — no point querying neighbours of a
    // property that isn't in this profile's candidate set.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("treats a NULL anchor effective_score as NO_SCORE_SENTINEL when comparing neighbours", async () => {
    // The anchor query now reads the blended `effective_score` from the ranked
    // CTE (#309); a never-scored, no-signal anchor comes back null.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ effective_score: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // next
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // prev

    await getAdjacentCandidates(1, 5);

    const nextParams = mockPoolQuery.mock.calls[1][1];
    const prevParams = mockPoolQuery.mock.calls[2][1];
    // anchorScore param (index 1) must be the -1 sentinel, not null/NaN —
    // otherwise the `< $2::double precision` comparison is unusable SQL-side.
    expect(nextParams[1]).toBe(-1);
    expect(prevParams[1]).toBe(-1);
  });

  it("returns null for a side with no neighbour (top/bottom of the ranking) while still returning the other side", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ effective_score: "0.91" }] }); // anchor
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no next (top of ranking)
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ property_id: 3 }] }); // prev exists

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
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ effective_score: "0.5" }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ property_id: 42 }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ property_id: 7 }] });

    const result = await getAdjacentCandidates(1, 5);
    expect(result.nextPropertyId).toBe(42);
    expect(typeof result.nextPropertyId).toBe("number");
    expect(result.prevPropertyId).toBe(7);
  });

  it("reuses listCandidates's exact keyset ordering/comparison — same blended effective_score, same (score, id) compound tiebreak direction", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ effective_score: "0.5" }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getAdjacentCandidates(1, 5);

    const [nextSql] = mockPoolQuery.mock.calls[1];
    const [prevSql] = mockPoolQuery.mock.calls[2];
    // "next" (ranked worse) sorts DESC and compares strictly-less-than the
    // anchor, mirroring listCandidates's page-forward direction — now on the
    // blended effective_score (#309), not the raw score.
    expect(nextSql).toContain("ORDER BY effective_score DESC, property_id DESC");
    expect(nextSql).toContain("< $2::double precision");
    // "prev" (ranked better) reverses both the sort and the comparison.
    expect(prevSql).toContain("ORDER BY effective_score ASC, property_id ASC");
    expect(prevSql).toContain("> $2::double precision");
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
});
