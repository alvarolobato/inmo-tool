// @vitest-environment node
/**
 * Unit tests for POST /api/extension/diagnostic (issue #671) — the
 * browser-extension's "forzar captura + diagnóstico" report. Same
 * admin-gating pattern as capture/block-episode; mocks
 * @/lib/db/extension-diagnostics so no real DB connection is required (see
 * diagnostic-no-ingest.integration.test.ts for the real-DB proof that this
 * route never touches `listing`/`capture_worklist`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/extension-diagnostics", () => ({
  insertDiagnostic: vi.fn(),
}));

import { POST } from "../diagnostic/route";
import * as db from "@/lib/db/extension-diagnostics";

const mockInsert = vi.mocked(db.insertDiagnostic);

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
    expect(body).toEqual({ success: true, id: 42 });
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
});
