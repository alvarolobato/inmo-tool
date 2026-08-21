// @vitest-environment node
/**
 * Unit tests for GET/DELETE /api/admin/diagnostics/[id] — the no-SQL
 * retrieval surface for extension diagnostics (issue #671).
 *
 * Added by the PR #675 review:
 *   - B3: the route loaded the full row and then returned `diagnostic.html`
 *     and nothing else, discarding `detection` and `network`. Combined with a
 *     list page that renders ~6 of ~13 fields, that left
 *     `harvest.extractDetailUrlsCount` (the "0 of 17" number the Hipoges case
 *     is entirely about), `renderReady.reason` and `bodyTextLength` reachable
 *     only by hand-written SQL — which the issue explicitly ruled out.
 *     `?format=json` closes it.
 *   - S3: the HTML download declared `text/html`. `Content-Disposition:
 *     attachment` does force a download and nothing under app/admin/ renders
 *     this content inline, so this is defense in depth rather than a live
 *     hole — but the one header that could ever make a browser choose to
 *     render untrusted third-party markup should not say "html".
 *
 * `@/lib/db/extension-diagnostics` is mocked — this file is about the route's
 * response shaping, not about persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/extension-diagnostics", () => ({
  getDiagnostic: vi.fn(),
  deleteDiagnostic: vi.fn(),
}));

import { GET, DELETE } from "../[id]/route";
import * as db from "@/lib/db/extension-diagnostics";

const mockGet = vi.mocked(db.getDiagnostic);
const mockDelete = vi.mocked(db.deleteDiagnostic);

const ADMIN_KEY = "test-admin-key";

function req(path: string, opts: { adminKey?: string; method?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest(`http://localhost:4000${path}`, {
    method: opts.method ?? "GET",
    headers,
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const FULL_ROW = {
  id: 7,
  url: "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/sevilla",
  title: "Hipoges listado",
  createdAt: "2026-08-21T10:00:00.000Z",
  htmlBytes: 1234,
  extensionVersion: "0.16.0",
  detailPortal: null,
  listingPortal: "hipoges",
  pageRole: "listing",
  renderReady: true,
  renderReadySelector: "main",
  renderReadyReason: "generic fallback selector matched",
  renderReadyBodyTextLength: 480,
  anchorCount: 17,
  extractDetailUrlsCount: 0,
  blocked: false,
  blockSignature: null,
  autoCaptureWouldFire: false,
  networkEntryCount: 1,
  networkDroppedCount: 0,
  html: "<html><body><main>shell</main></body></html>",
  detection: {
    renderReady: { ready: true, selector: "main", reason: "generic", bodyTextLength: 480 },
    harvest: { anchorCount: 17, extractDetailUrlsCount: 0 },
  },
  network: { entries: [{ url: "https://x/api", method: "GET" }], droppedCount: 0 },
} as unknown as Awaited<ReturnType<typeof db.getDiagnostic>>;

describe("GET /api/admin/diagnostics/[id]", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key and never reads the row", async () => {
    const res = await GET(req("/api/admin/diagnostics/7"), params("7"));
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await GET(req("/api/admin/diagnostics/abc", { adminKey: ADMIN_KEY }), params("abc"));
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns 404 when the diagnostic doesn't exist", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(req("/api/admin/diagnostics/7", { adminKey: ADMIN_KEY }), params("7"));
    expect(res.status).toBe(404);
  });

  describe("default (download) shape — S3", () => {
    it("serves the HTML as an octet-stream attachment with nosniff, never text/html", async () => {
      mockGet.mockResolvedValue(FULL_ROW);
      const res = await GET(req("/api/admin/diagnostics/7", { adminKey: ADMIN_KEY }), params("7"));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FULL_ROW!.html);

      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toBe("application/octet-stream");
      expect(contentType).not.toContain("text/html");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("?format=json shape — B3", () => {
    it("returns every stored field the list page can't show", async () => {
      mockGet.mockResolvedValue(FULL_ROW);
      const res = await GET(
        req("/api/admin/diagnostics/7?format=json", { adminKey: ADMIN_KEY }),
        params("7"),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();

      // The exact fields B3 named as SQL-only before this route existed.
      expect(body.detection.harvest.anchorCount).toBe(17);
      expect(body.detection.harvest.extractDetailUrlsCount).toBe(0);
      expect(body.detection.renderReady.reason).toBe("generic");
      expect(body.detection.renderReady.bodyTextLength).toBe(480);
      expect(body.network.entries).toHaveLength(1);
      expect(body.network.droppedCount).toBe(0);
      // ...plus the summary fields, so this is genuinely the whole row.
      expect(body.id).toBe(7);
      expect(body.url).toBe(FULL_ROW!.url);
      expect(body.extensionVersion).toBe("0.16.0");
    });

    it("omits `html` — it has its own safe delivery path and a JSON response renders inline", async () => {
      mockGet.mockResolvedValue(FULL_ROW);
      const res = await GET(
        req("/api/admin/diagnostics/7?format=json", { adminKey: ADMIN_KEY }),
        params("7"),
      );
      const body = await res.json();

      expect(body).not.toHaveProperty("html");
      expect(JSON.stringify(body)).not.toContain("<main>");
      // The size field survives, so the list still knows how big it was.
      expect(body.htmlBytes).toBe(1234);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("any other format value falls through to the download, not to JSON", async () => {
      mockGet.mockResolvedValue(FULL_ROW);
      const res = await GET(
        req("/api/admin/diagnostics/7?format=html", { adminKey: ADMIN_KEY }),
        params("7"),
      );
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
    });
  });
});

describe("DELETE /api/admin/diagnostics/[id]", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key and never deletes", async () => {
    const res = await DELETE(req("/api/admin/diagnostics/7", { method: "DELETE" }), params("7"));
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes and reports success", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await DELETE(
      req("/api/admin/diagnostics/7", { adminKey: ADMIN_KEY, method: "DELETE" }),
      params("7"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith(7);
  });

  it("returns 404 when the row was already gone", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await DELETE(
      req("/api/admin/diagnostics/7", { adminKey: ADMIN_KEY, method: "DELETE" }),
      params("7"),
    );
    expect(res.status).toBe(404);
  });
});
