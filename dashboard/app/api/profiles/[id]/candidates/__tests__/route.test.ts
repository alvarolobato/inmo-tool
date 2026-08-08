import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  // db-shared.ts (#155) registers the int8 type parser at module load — the
  // mock needs a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import { GET } from "../route";
import { GET as SOURCES_GET } from "../../candidate-sources/route";
import { resetPool } from "@/lib/db-write";
import { OCCUPIED_STATUSES, WARN_CAVEAT_CODES } from "@/lib/candidates";
import { NextRequest } from "next/server";

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

const ctx = (id: string) => ({ params: { id } });

// #425: listCandidates now issues a novelty-context RESOLVE query (detected by
// its `never_visited` column) before its main query. The mock routes that
// transparently to a fixed row so tests keep queueing only profile + main +
// (loadFlags/sources) results, in order, via `queue`.
const FIXED_ANCHOR = "2020-01-01T00:00:00.000Z";
const RESOLVE_ROW = {
  anchor_ts: FIXED_ANCHOR,
  never_visited: false,
  total: 0,
  fresh: 0,
};
// #425 param threading appended after the #422 state filter ($18): tier ($19,
// null on page 1), anchor ($20), sanity band ($21/$22), cold start ($23).
const NOVELTY_TAIL_PAGE1 = [null, FIXED_ANCHOR, 0.01, 0.6, false] as const;
let queue: Array<{ rows: unknown[] } | Error>;
function enqueue(...vals: Array<{ rows: unknown[] } | Error>): void {
  queue.push(...vals);
}
/** The main candidate-list query (carrying the fresh-first ORDER BY). */
function candidatesCall(): [string, unknown[]] {
  const call = mockQuery.mock.calls.find(
    (c) =>
      typeof c[0] === "string" && c[0].includes("ORDER BY ranked.novelty_tier"),
  );
  if (!call) throw new Error("no main candidate query was issued");
  return call as [string, unknown[]];
}
function candidatesParams(): unknown[] {
  return candidatesCall()[1];
}

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: 3,
  name: "Perfil",
  scope: {
    geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    property_types: ["piso"],
  },
  thesis_params: {},
  archived_at: null,
  created_at: "2026-08-02T00:00:00.000Z",
  last_materialized_at: null,
  last_viewed_at: null,
  ...overrides,
});

beforeEach(async () => {
  mockQuery.mockReset();
  mockEnd.mockClear();
  queue = [];
  mockQuery.mockImplementation((text: unknown) => {
    if (typeof text === "string" && text.includes("never_visited")) {
      return Promise.resolve({ rows: [RESOLVE_ROW] });
    }
    const next = queue.length > 0 ? queue.shift()! : { rows: [] };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  await resetPool();
});

describe("GET /api/profiles/[id]/candidates — source (portal) filter (#265)", () => {
  it("rejects a malformed source before touching the DB (400)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?source=Idealista!",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an uppercase source (slugs are lowercase) (400)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?source=IDEALISTA",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("accepts a valid slug and passes it as $5 to listCandidates", async () => {
    // 1st query: getProfileById. 2nd: listCandidates main query (empty result
    // → loadFlags issues no further query).
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?source=milanuncios_rental",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [],
      nextCursor: null,
      coldStart: false,
    });

    const candidatesCallArr = candidatesCall();
    expect(candidatesCallArr[0]).toContain("lf.source = $5");
    // #310 appended $7–$11 (occupancy, occupied-statuses list, condition,
    // renovation, min-below-market); #386 appended $13/$14 (caveat, redflagType);
    // #392 appended $15/$16 (beachProximity, heritageZone); all null/default when
    // only source is set.
    expect(candidatesCallArr[1]).toEqual([
      3,
      null,
      null,
      31,
      "milanuncios_rental",
      WARN_CAVEAT_CODES,
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
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
    ]);
  });

  it("treats an absent source as no filter ($5 = null)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(candidatesParams()).toEqual([
      3,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
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
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
    ]);
  });
});

describe("GET /api/profiles/[id]/candidates — #310 hard filters (D-059)", () => {
  it("rejects an unknown occupancy value before touching the DB (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?occupancy=maybe"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown condition value (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?condition=ruina"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown renovation value (400)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?renovation=media",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a minDiscount outside 0–100 (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?minDiscount=150"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric minDiscount (400)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?minDiscount=cheap",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes valid filters through: occupancy=$7, condition=$9, renovation=$10, minDiscount(pct→fraction)=$11", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?occupancy=occupied&condition=a_reformar&renovation=integral&minDiscount=15",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(candidatesParams()).toEqual([
      3,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      "occupied",
      OCCUPIED_STATUSES,
      "a_reformar",
      "integral",
      0.15, // 15% → fraction
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      ...NOVELTY_TAIL_PAGE1,
      null, // #466 hasAlerts ($24), off by default
    ]);
  });

  it("rejects an unknown caveat value before touching the DB (400) (#386)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?caveat=hipoteca"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown redflagType value (400) (#386)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?redflagType=goteras",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes valid caveat=$13 and redflagType=$14 through to listCandidates (#386)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?caveat=venta_deuda&redflagType=unfinished_construction",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = candidatesParams();
    expect(params[12]).toBe("venta_deuda");
    expect(params[13]).toBe("unfinished_construction");
  });

  it("accepts subasta_judicial as a valid redflagType and passes it through (#389)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?redflagType=subasta_judicial",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = candidatesParams();
    expect(params[13]).toBe("subasta_judicial");
  });

  it("accepts sin_financiacion_hipotecaria as a valid redflagType and passes it through (#408)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?redflagType=sin_financiacion_hipotecaria",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = candidatesParams();
    expect(params[13]).toBe("sin_financiacion_hipotecaria");
  });

  it("accepts cambio_uso_pendiente as a valid redflagType and passes it through (#408)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?redflagType=cambio_uso_pendiente",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = candidatesParams();
    expect(params[13]).toBe("cambio_uso_pendiente");
  });

  it("rejects an unknown beachProximity value before touching the DB (400) (#392)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?beachProximity=oceanfront",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects `none` as a beachProximity value — it is not a filter target (400) (#392)", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?beachProximity=none",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes a valid beachProximity=$15 through to listCandidates (#392)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?beachProximity=frontline",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(candidatesParams()[14]).toBe("frontline");
  });

  it("passes heritageZone=true through as $16=true, and any other value as null (#392)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });
    const on = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?heritageZone=true",
      ),
      ctx("3"),
    );
    expect(on.status).toBe(200);
    expect(candidatesParams()[15]).toBe(true);

    for (const raw of ["", "1", "false", "yes"]) {
      mockQuery.mockClear();
      queue = [];
      enqueue({ rows: [profileRow()] });
      enqueue({ rows: [] });
      const off = await GET(
        makeRequest(
          `http://localhost/api/profiles/3/candidates?heritageZone=${raw}`,
        ),
        ctx("3"),
      );
      expect(off.status).toBe(200);
      expect(candidatesParams()[15]).toBeNull();
    }
  });

  it("rejects an invalid isVpo value before touching the DB (400) (#398)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?isVpo=maybe"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes isVpo bidirectionally as $17 (true/false), and absent/empty as null (#398)", async () => {
    // true = only VPO.
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });
    const only = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?isVpo=true"),
      ctx("3"),
    );
    expect(only.status).toBe(200);
    expect(candidatesParams()[16]).toBe(true);

    // false = exclude VPO.
    mockQuery.mockClear();
    queue = [];
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });
    const exclude = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?isVpo=false"),
      ctx("3"),
    );
    expect(exclude.status).toBe(200);
    expect(candidatesParams()[16]).toBe(false);

    // absent/empty = off (null).
    for (const url of [
      "http://localhost/api/profiles/3/candidates",
      "http://localhost/api/profiles/3/candidates?isVpo=",
    ]) {
      mockQuery.mockClear();
      queue = [];
      enqueue({ rows: [profileRow()] });
      enqueue({ rows: [] });
      const off = await GET(makeRequest(url), ctx("3"));
      expect(off.status).toBe(200);
      expect(candidatesParams()[16]).toBeNull();
    }
  });

  it("passes includeRejected=true to listCandidates as $12 when the show-rejected toggle is on (#379)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?includeRejected=true",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = candidatesParams();
    // $12 is the includeRejected flag ($13/$14 caveat/redflagType follow it).
    expect(params[11]).toBe(true);
  });

  it("keeps rejected hidden ($12 = false) for any includeRejected value other than the exact string 'true' (#379)", async () => {
    for (const raw of ["", "1", "false", "TRUE", "yes"]) {
      mockQuery.mockClear();
      queue = [];
      enqueue({ rows: [profileRow()] });
      enqueue({ rows: [] });
      const res = await GET(
        makeRequest(
          `http://localhost/api/profiles/3/candidates?includeRejected=${raw}`,
        ),
        ctx("3"),
      );
      expect(res.status).toBe(200);
      expect(candidatesParams()[11]).toBe(false);
    }
  });

  it("passes state=accept to listCandidates as $18 (the 'En seguimiento' working set, #422)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?state=accept"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    // $18 (index 17) is the seguimiento state filter.
    expect(candidatesParams()[17]).toBe("accept");
  });

  it("leaves the state filter off ($18 = null) when the param is absent (#422)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(candidatesParams()[17]).toBeNull();
  });

  it("rejects an unknown state value with 400 (#422)", async () => {
    for (const raw of ["reject", "star", "accepted", "yes"]) {
      mockQuery.mockClear();
      queue = [];
      enqueue({ rows: [profileRow()] });
      enqueue({ rows: [] });
      const res = await GET(
        makeRequest(`http://localhost/api/profiles/3/candidates?state=${raw}`),
        ctx("3"),
      );
      expect(res.status).toBe(400);
    }
  });

  it("passes hasAlerts=true to listCandidates as $24 (the 'Con alertas' UNION filter, #466)", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?hasAlerts=true"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    // $24 (index 23) is the new UNION toggle.
    expect(candidatesParams()[23]).toBe(true);
  });

  it("leaves hasAlerts off ($24 = null) when absent, and rejects any value other than 'true' with 400 (#466)", async () => {
    // Absent → off (null), DB touched.
    enqueue({ rows: [profileRow()] });
    enqueue({ rows: [] });
    const off = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates"),
      ctx("3"),
    );
    expect(off.status).toBe(200);
    expect(candidatesParams()[23]).toBeNull();

    // Any non-empty value other than the exact "true" → 400 before the DB.
    for (const raw of ["1", "false", "TRUE", "yes"]) {
      mockQuery.mockClear();
      queue = [];
      const res = await GET(
        makeRequest(`http://localhost/api/profiles/3/candidates?hasAlerts=${raw}`),
        ctx("3"),
      );
      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  });
});

describe("GET /api/profiles/[id]/candidate-sources (#265)", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/abc/candidate-sources"),
      ctx("abc"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for an archived profile", async () => {
    enqueue({ rows: [profileRow({ archived_at: "2026-08-01T00:00:00Z" })] });
    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/3/candidate-sources"),
      ctx("3"),
    );
    expect(res.status).toBe(404);
  });

  it("returns the distinct sources for an active profile", async () => {
    enqueue({ rows: [profileRow()] });
    enqueue({
      rows: [
        { source: "aliseda" },
        { source: "fotocasa" },
        { source: "idealista" },
      ],
    });

    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/3/candidate-sources"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sources: ["aliseda", "fotocasa", "idealista"],
    });
  });
});
