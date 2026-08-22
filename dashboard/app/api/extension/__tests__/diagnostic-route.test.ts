// @vitest-environment node
/**
 * Unit tests for POST /api/extension/diagnostic (issue #671) — the
 * browser-extension's "forzar captura + diagnóstico" report. Same
 * admin-gating pattern as capture/block-episode; mocks
 * @/lib/db/extension-diagnostics so no real DB connection is required (see
 * diagnostic-no-ingest.integration.test.ts for the real-DB proof that this
 * route never touches `listing`/`capture_worklist`).
 *
 * Issue #705 added one post-insert step — closing the prospective-site request
 * this page was queued for — so @/lib/db/spike-queue is mocked here too. Two
 * contracts are pinned below: closure happens BY ID whenever the driver echoes
 * back the `spikeRequestId` the planner handed it (the only form that survives
 * a redirect, review F1), and a failure in that step must never fail the POST.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/extension-diagnostics", () => ({
  insertDiagnostic: vi.fn(),
}));

vi.mock("@/lib/db/spike-queue", () => ({
  correlateSpikeDiagnostic: vi.fn(),
  markSpikeCaptured: vi.fn(),
}));

import { POST } from "../diagnostic/route";
import * as db from "@/lib/db/extension-diagnostics";
import * as spikeDb from "@/lib/db/spike-queue";

const mockInsert = vi.mocked(db.insertDiagnostic);
const mockCorrelate = vi.mocked(spikeDb.correlateSpikeDiagnostic);
const mockMarkCaptured = vi.mocked(spikeDb.markSpikeCaptured);

const ADMIN_KEY = "test-admin-key";

function makeRequest(
  body: Record<string, unknown> | null,
  opts: { adminKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/extension/diagnostic", {
    method: "POST",
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/extension/diagnostic", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
    mockCorrelate.mockResolvedValue(null);
    mockMarkCaptured.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key and never writes", async () => {
    const res = await POST(
      makeRequest({ url: "https://www.idealista.com/inmueble/1/", html: "<html></html>" }),
    );
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when url is missing", async () => {
    const res = await POST(makeRequest({ html: "<html></html>" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when html is missing", async () => {
    const res = await POST(
      makeRequest({ url: "https://www.idealista.com/inmueble/1/" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 for a javascript: URL (same guard as /api/extension/capture)", async () => {
    const res = await POST(
      makeRequest(
        { url: "javascript://idealista.com/%0aalert(1)", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 for an oversized network payload", async () => {
    const res = await POST(
      makeRequest(
        {
          url: "https://www.idealista.com/inmueble/1/",
          html: "<html></html>",
          network: { entries: [{ body: "x".repeat(9 * 1024 * 1024) }], droppedCount: 0 },
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("inserts a valid diagnostic and returns its id — works on an UNSUPPORTED host (null detection)", async () => {
    mockInsert.mockResolvedValue(42);
    const res = await POST(
      makeRequest(
        {
          url: "https://www.some-unsupported-portal.example/anuncio/1",
          html: "<html><body>hi</body></html>",
          title: "Un anuncio",
          diagnostic: {
            detection: { detailPortal: null, listingPortal: null, supportedPortal: null, pageRole: null },
            renderReady: { ready: false, selector: null, reason: "no_key_node", bodyTextLength: 2 },
            harvest: { anchorCount: 0, extractDetailUrlsCount: 0 },
            block: { blocked: false, signature: null },
            mode: { discoverSignalPresent: false, validationActive: false, autoCaptureEnabled: true },
            autoCaptureWouldFire: false,
          },
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // `spikeRequestId` is null for the overwhelmingly common caller — the
    // #675 manual button on a page nobody queued (issue #705).
    expect(body).toEqual({ success: true, id: 42, spikeRequestId: null });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const call = mockInsert.mock.calls[0][0];
    expect(call.url).toBe("https://www.some-unsupported-portal.example/anuncio/1");
    expect(call.detection?.detection.detailPortal).toBeNull();
  });

  it("accepts a request with no diagnostic/network block at all (an unclassifiable page must still be sendable)", async () => {
    mockInsert.mockResolvedValue(7);
    const res = await POST(
      makeRequest(
        { url: "https://www.idealista.com/inmueble/1/", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].detection).toBeNull();
    expect(mockInsert.mock.calls[0][0].network).toBeNull();
  });

  // ── Prospective-site closure (issue #705) ─────────────────────────────
  it("closes the queue row BY ID when the driver echoes back spikeRequestId — even after a redirect", async () => {
    // Review F1, the blocker this replaces: the driver reports
    // window.location.href, i.e. the URL AFTER redirects, and the match key is
    // host+path — so a locale prefix (/es/) produces a key that matches
    // nothing, the row stays pending at attempts 0, and the planner hands it
    // back every tick forever while storing a fresh 10 MB-capped page each
    // time. The id makes the URL irrelevant.
    mockInsert.mockResolvedValue(77);
    mockMarkCaptured.mockResolvedValue(11);
    const res = await POST(
      makeRequest(
        {
          url: "https://www.ejemplo-portal.test/es/inmueble/7",
          html: "<html><body>x</body></html>",
          spikeRequestId: 11,
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id: 77, spikeRequestId: 11 });
    expect(mockMarkCaptured).toHaveBeenCalledWith(11, 77);
    // The URL-derived fallback must not even be consulted when an id is given.
    expect(mockCorrelate).not.toHaveBeenCalled();
  });

  it("ignores a malformed spikeRequestId rather than 400ing — the page is what matters", async () => {
    mockInsert.mockResolvedValue(78);
    const res = await POST(
      makeRequest(
        {
          url: "https://www.ejemplo-portal.test/inmueble/9",
          html: "<html></html>",
          spikeRequestId: "11" as unknown as number,
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockMarkCaptured).not.toHaveBeenCalled();
    expect(mockCorrelate).toHaveBeenCalled(); // falls back to the match key
  });

  it("falls back to the canonical match key for the #675 manual button, which has no id", async () => {
    mockInsert.mockResolvedValue(99);
    mockCorrelate.mockResolvedValue(12);
    const res = await POST(
      makeRequest(
        {
          // Trailing slash + query: correlation must be tolerant of cosmetic
          // URL differences, or a real capture silently fails to close its own
          // queue row.
          url: "https://www.ejemplo-portal.test/inmueble/7/?utm_source=x",
          html: "<html><body>x</body></html>",
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id: 99, spikeRequestId: 12 });
    expect(mockCorrelate).toHaveBeenCalledWith("ejemplo-portal.test/inmueble/7", 99);
  });

  it("still returns 200 when correlation throws — the page is already stored, which is the irreplaceable part", async () => {
    mockInsert.mockResolvedValue(100);
    mockCorrelate.mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeRequest(
        { url: "https://www.ejemplo-portal.test/inmueble/8", html: "<html></html>" },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id: 100, spikeRequestId: null });
  });
});
