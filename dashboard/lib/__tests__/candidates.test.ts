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
    expect(params).toEqual([7, null, 30]);
  });

  it("passes the cursor and clamps limit to [1, 100]", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await listCandidates(7, { cursor: 42, limit: 500 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, 42, 100]);

    mockPoolQuery.mockClear();
    await listCandidates(7, { limit: 0 });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, null, 1]);
  });

  it("sets nextCursor to the last item's property_id only when a full page was returned", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { property_id: 3, address: null, lat: null, lon: null, property_type: null, m2_built: null, rooms: null, min_price: null, first_seen_at: null, listings: [] },
        { property_id: 2, address: null, lat: null, lon: null, property_type: null, m2_built: null, rooms: null, min_price: null, first_seen_at: null, listings: [] },
      ],
    });
    const fullPage = await listCandidates(1, { limit: 2 });
    expect(fullPage.nextCursor).toBe(2);

    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { property_id: 3, address: null, lat: null, lon: null, property_type: null, m2_built: null, rooms: null, min_price: null, first_seen_at: null, listings: [] },
      ],
    });
    const partialPage = await listCandidates(1, { limit: 2 });
    expect(partialPage.nextCursor).toBeNull();
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
});
