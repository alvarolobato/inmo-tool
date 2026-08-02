import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPoolQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class {
    query = mockPoolQuery;
    end = mockEnd;
  },
}));

import { listCandidates } from "../candidates";
import { resetPool } from "@/lib/db-write";

describe("listCandidates", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    await resetPool();
  });

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
    // happens to be exactly full — see the nextCursor tests below.
    expect(params).toEqual([7, null, 31]);
  });

  it("passes the cursor and clamps limit to [1, 100] (querying limit+1 rows)", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await listCandidates(7, { cursor: 42, limit: 500 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, 42, 101]);

    mockPoolQuery.mockClear();
    await listCandidates(7, { limit: 0 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, null, 2]);
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

  it("sets nextCursor only when a real next page exists (extra row is fetched and trimmed, not inferred from a full page)", async () => {
    // limit=2, DB returns 3 rows (limit+1) => a real next page exists.
    mockPoolQuery.mockResolvedValueOnce({ rows: [stubRow(3), stubRow(2), stubRow(1)] });
    const withMore = await listCandidates(1, { limit: 2 });
    expect(withMore.items).toHaveLength(2);
    expect(withMore.items.map((i) => i.property_id)).toEqual([3, 2]);
    expect(withMore.nextCursor).toBe(2);

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

  it("coerces property_id (a pg bigint, returned as a string) to a JSON number", async () => {
    // pg returns bigint columns as JS strings, not numbers — property_id
    // was previously shipped as-is ("179" not 179) while every other
    // numeric column here already got a Number(...) conversion. Harmless
    // today, but Phase 3's scoring/ranking will compare/sort on this field.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...stubRow(0), property_id: "179" as unknown as number }],
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
          rank_explanation: "Ranking alto: precio un 8% por debajo de lo habitual en este perfil.",
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
});
