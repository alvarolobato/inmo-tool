// @vitest-environment node
/**
 * Unit tests for POST /api/extension/capture — the browser-extension
 * listing-capture endpoint (issue #75). Covers the two security fixes from
 * Opus's review of PR #87: the endpoint was previously unauthenticated, and
 * accepted non-http(s) URL schemes (verified end-to-end exploitable via a
 * `javascript:` URL with a legitimate-looking hostname).
 *
 * Mocks @/lib/db-write so no real DB connection is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { POST } from "../capture/route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);

const ADMIN_KEY = "test-admin-key";

function makeRequest(
  body: Record<string, unknown>,
  opts: { adminKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) {
    headers["x-admin-key"] = opts.adminKey;
  }
  return new NextRequest("http://localhost:4000/api/extension/capture", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/extension/capture", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key", async () => {
    const res = await POST(
      makeRequest({ url: "https://www.idealista.com/inmueble/1/", html: "<html></html>" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a javascript: URL even with a valid admin key and legitimate-looking hostname", async () => {
    // Real payload traced end-to-end by the reviewer: a scheme mismatch
    // hostname-matches idealista.com in etl/capture.py's allowlist while
    // never being a real network request.
    const res = await POST(
      makeRequest(
        { url: "javascript://idealista.com/inmueble/1/%0aalert(1)", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects a data: URL with a valid admin key", async () => {
    const res = await POST(
      makeRequest(
        { url: "data:text/html,<script>alert(1)</script>", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("accepts a valid http(s) URL with a valid admin key", async () => {
    mockSql.mockResolvedValue([{ id: 42 }]);

    const res = await POST(
      makeRequest(
        { url: "https://www.idealista.com/inmueble/106387165/", html: "<html>real</html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.capture_id).toBe(42);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});


describe("NUL bytes in the captured payload (issue #207 — a real 500 in production)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ id: 42 }]);
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a page whose DOM carries a NUL instead of 500ing", async () => {
    // The owner's first real Hipoges capture failed with Postgres'
    // `invalid byte sequence for encoding "UTF8": 0x00`. A text column cannot
    // hold U+0000, so the INSERT threw and the capture was lost behind a
    // generic 500. Nothing Hipoges-specific — the endpoint had no guard for
    // any source, so this was latent for every portal.
    const html = `<html><body><h1>Piso\u0000 en Dos Hermanas</h1></body></html>`;
    const res = await POST(
      makeRequest(
        { url: "https://realestate.hipoges.com/es/detail/12345", html },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    // U+FFFD, not deletion: the HTML spec's tokenizer substitutes U+FFFD for
    // U+0000, so this is what the browser rendering the page saw, and it keeps
    // downstream character offsets stable.
    expect(params[1]).toBe(`<html><body><h1>Piso\uFFFD en Dos Hermanas</h1></body></html>`);
    expect(params[1]).not.toContain("\u0000");
  });

  it("sanitises the url too — a NUL anywhere in the tuple fails the same INSERT", async () => {
    const res = await POST(
      makeRequest(
        { url: "https://realestate.hipoges.com/es/detail/1\u000023", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).not.toContain("\u0000");
  });

  it("leaves a clean payload byte-identical — no cost on the common path", async () => {
    const html = "<html><body>sin nulos</body></html>";
    await POST(
      makeRequest({ url: "https://realestate.hipoges.com/es/detail/7", html }, { adminKey: ADMIN_KEY }),
    );
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(html);
  });
});


describe("renderWaitMs coercion (issue #700, D-162) — the value that reaches the INSERT", () => {
  // `render_wait_ms` is the only column on this table written by a value the
  // extension computes, and the extension is an independently-installed Chrome
  // artifact reachable by anything holding the admin key. Two things must hold
  // at once: a nonsense duration must never turn a perfectly good capture into
  // a 500 at the INSERT, and "not measured" must reach the DB as NULL rather
  // than as a 0 that asserts "instant" (D-162 rule 2).
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ id: 7 }]);
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The third INSERT parameter — what actually lands in render_wait_ms. */
  async function insertedRenderWait(body: Record<string, unknown>): Promise<unknown> {
    const res = await POST(makeRequest(body, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const [sqlText, params] = mockSql.mock.calls[0] as [string, unknown[]];
    // Pin the column list too: adding a column without extending this tuple is
    // the other way this silently becomes NULL forever.
    expect(sqlText).toContain("(url, html, render_wait_ms)");
    expect(params).toHaveLength(3);
    return params[2];
  }

  const URL_OK = "https://realestate.hipoges.com/es/detail/12345";
  const HTML_OK = "<html><body>anuncio</body></html>";

  it("stores a plain measured duration", async () => {
    expect(await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: 19500 })).toBe(
      19500,
    );
  });

  it("stores 0 as 0 — an instant render is a measurement, not an absence", async () => {
    expect(await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: 0 })).toBe(0);
  });

  it("rounds a fractional duration to an integer (the column is INTEGER)", async () => {
    expect(await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: 1234.6 })).toBe(
      1235,
    );
  });

  it("stores NULL when the field is absent — an older extension build", async () => {
    expect(await insertedRenderWait({ url: URL_OK, html: HTML_OK })).toBeNull();
  });

  it.each([
    ["explicit null", null],
    ["a numeric string", "19500"],
    ["a boolean", true],
    ["an object", { ms: 100 }],
    ["an array", [100]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a negative duration", -1],
    ["past the 10-minute ceiling", 10 * 60 * 1000 + 1],
    ["past int4 range", 2_147_483_648],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ])("stores NULL for %s, and still stores the capture", async (_label, value) => {
    // Discarded, never rejected: the CAPTURE is the payload that matters, and
    // losing a listing over a bad telemetry field would be strictly worse than
    // losing the telemetry.
    expect(
      await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: value }),
    ).toBeNull();
  });

  it("accepts the exact ceiling, rejects one past it", async () => {
    const CEILING = 10 * 60 * 1000;
    expect(await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: CEILING })).toBe(
      CEILING,
    );
    mockSql.mockClear();
    expect(
      await insertedRenderWait({ url: URL_OK, html: HTML_OK, renderWaitMs: CEILING + 1 }),
    ).toBeNull();
  });

  it("a hostile renderWaitMs never costs the capture — url and html land intact", async () => {
    await POST(
      makeRequest(
        { url: URL_OK, html: HTML_OK, renderWaitMs: "'; DROP TABLE extension_capture; --" },
        { adminKey: ADMIN_KEY },
      ),
    );
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(URL_OK);
    expect(params[1]).toBe(HTML_OK);
    expect(params[2]).toBeNull();
  });
});

/**
 * Abandoned render waits (issue #701).
 *
 * Before this, a page that never rendered POSTed nothing at all: no row, no
 * counter, no trace. A portal timing out on every page looked identical, in
 * every metric the project has, to a portal nobody had opened — which is how
 * "hipoges tarda mucho y falla" got reported twice and only ever measured.
 */
describe("POST /api/extension/capture — outcome: never_rendered", () => {
  const HIPOGES_URL = "https://realestate.hipoges.com/es/detail/RARE-04347";
  const PLAIN_URL = "https://www.idealista.com/inmueble/1/";
  const PLAIN_HTML = "<html><body>ok</body></html>";

  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
    mockSql.mockResolvedValue([{ id: 7 }] as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes a TERMINAL row, never a pending one", async () => {
    // The load-bearing property: `pending` would make etl/capture.py's poll
    // pick the row up and spend a parse on a page the extension already
    // established has no advert on it.
    const res = await POST(
      makeRequest(
        { url: HIPOGES_URL, html: "<html>shell</html>", outcome: "never_rendered", renderWaitMs: 45000 },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("'never_rendered'");
    expect(query).toContain("processed_at");
    expect(query).not.toContain("'pending'");
    expect(params[2]).toBe(45000);
  });

  it("folds the diagnostic into a readable error_msg", async () => {
    await POST(
      makeRequest(
        {
          url: HIPOGES_URL,
          html: "<html></html>",
          outcome: "never_rendered",
          role: "listing",
          diagnostic: { reason: "still_loading", harvested: 0, placeholders: 13 },
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    const msg = String(params[3]);
    expect(msg).toContain("no llegó a renderizarse");
    expect(msg).toContain("tipo=listing");
    expect(msg).toContain("motivo=still_loading");
    expect(msg).toContain("placeholders=13");
    // No CDN misses on this one, so the field stays out of the line entirely
    // rather than reading a reassuring "refs_ilegibles=0".
    expect(msg).not.toContain("refs_ilegibles");
  });

  it("names how many results the page claimed, next to how many were harvested", async () => {
    // issue #701 review M3: "anuncios=4" alone cannot be read. "anuncios=4
    // esperados=17" says the page painted a quarter of itself and stopped.
    await POST(
      makeRequest(
        {
          url: HIPOGES_URL,
          html: "<html></html>",
          outcome: "never_rendered",
          role: "listing",
          diagnostic: { reason: "partial_harvest", harvested: 4, expected: 17, placeholders: 13 },
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    const msg = String((mockSql.mock.calls[0] as [string, unknown[]])[1][3]);
    expect(msg).toContain("motivo=partial_harvest");
    expect(msg).toContain("anuncios=4");
    expect(msg).toContain("esperados=17");
  });

  it("distinguishes a stale CDN rule from a page with no adverts on it", async () => {
    // issue #701 review L1. Both cases report `anuncios=0`; only one of them
    // means "the rule that finds adverts has stopped matching", and reading
    // that as a render failure is the conflation #701 exists to end.
    await POST(
      makeRequest(
        {
          url: HIPOGES_URL,
          html: "<html></html>",
          outcome: "never_rendered",
          role: "listing",
          diagnostic: { reason: "ref_shape_unmatched", harvested: 0, refMisses: 17 },
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    const msg = String((mockSql.mock.calls[0] as [string, unknown[]])[1][3]);
    expect(msg).toContain("motivo=ref_shape_unmatched");
    expect(msg).toContain("anuncios=0");
    expect(msg).toContain("refs_ilegibles=17");
  });

  it("accepts a page that produced no HTML at all", async () => {
    // By definition a never-rendered page may have almost nothing to send;
    // rejecting it for that would silence the exact case this exists for.
    const res = await POST(
      makeRequest({ url: HIPOGES_URL, outcome: "never_rendered" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(200);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBeNull();
  });

  it("still requires html on an ORDINARY capture", async () => {
    const res = await POST(makeRequest({ url: PLAIN_URL }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("ignores any outcome value it does not know, taking the normal pending path", async () => {
    // `outcome` is a closed enum on purpose: this endpoint is reachable by
    // anything holding the admin key, and a caller-named status could
    // fabricate a 'done' ingestion.
    for (const outcome of ["done", "withdrawn", "pending", "", null, 42]) {
      mockSql.mockClear();
      await POST(
        makeRequest({ url: PLAIN_URL, html: PLAIN_HTML, outcome }, { adminKey: ADMIN_KEY }),
      );
      const [query] = mockSql.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain("never_rendered");
      expect(query).not.toContain("status");
    }
  });

  it("still refuses a non-http(s) URL", async () => {
    const res = await POST(
      makeRequest(
        { url: "javascript://idealista.com/x", outcome: "never_rendered" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
