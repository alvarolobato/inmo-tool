// @vitest-environment node
/**
 * Unit tests for /api/profiles/[id]/connector-filters (issue #478 P1).
 *
 * Mocks the DB layer (getProfileById + the profile_connector_filter helpers) so
 * the route exercises its REAL auth + validation orchestration (admin key, id,
 * connector support, http(s) scheme, connector-host check, archived guard)
 * without a DB. Pattern: captured-search-urls/__tests__/route.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/profiles", () => ({
  getProfileById: vi.fn(),
}));
vi.mock("@/lib/db/profile-connector-filter", () => ({
  findOverridesForProfile: vi.fn(),
  upsertProfileConnectorFilter: vi.fn(),
  deleteProfileConnectorFilter: vi.fn(),
}));
vi.mock("@/lib/db/connector-search-preview", () => ({
  getConnectorOverrideHostSuffix: vi.fn(),
}));

import { GET, PUT, DELETE } from "../route";
import * as profilesDb from "@/lib/db/profiles";
import * as overridesDb from "@/lib/db/profile-connector-filter";
import * as registryDb from "@/lib/db/connector-search-preview";

const mockGetProfile = vi.mocked(profilesDb.getProfileById);
const mockFind = vi.mocked(overridesDb.findOverridesForProfile);
const mockUpsert = vi.mocked(overridesDb.upsertProfileConnectorFilter);
const mockDelete = vi.mocked(overridesDb.deleteProfileConnectorFilter);
const mockOverrideHostSuffix = vi.mocked(registryDb.getConnectorOverrideHostSuffix);

const ADMIN_KEY = "test-admin-key";
const IDEALISTA_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc%29%29";

// Minimal profile — only archived_at is read by the route.
const ACTIVE_PROFILE = { id: 7, name: "Sevilla", archived_at: null } as unknown as Awaited<
  ReturnType<typeof profilesDb.getProfileById>
>;

const ctx = { params: { id: "7" } };

function putReq(body: Record<string, unknown>, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/profiles/7/connector-filters", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function getReq(opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/profiles/7/connector-filters", {
    method: "GET",
    headers,
  });
}

function deleteReq(qs: string, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest(`http://localhost:4000/api/profiles/7/connector-filters${qs}`, {
    method: "DELETE",
    headers,
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
  vi.clearAllMocks();
  // Default: an HTTP connector the registry doesn't know / can't pin. Extension
  // portals (idealista) never consult this — CAPTURE_PORTALS short-circuits.
  mockOverrideHostSuffix.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/profiles/[id]/connector-filters", () => {
  it("401 without a valid admin key", async () => {
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("returns the overrides for the profile", async () => {
    const rows = [{ id: 1, profile_id: 7, connector: "idealista", section_key: "", url: IDEALISTA_URL, source: "manual", created_at: "x", updated_at: "x" }];
    mockFind.mockResolvedValue(rows as never);
    const res = await GET(getReq({ adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, rows });
    expect(mockFind).toHaveBeenCalledWith(7);
  });
});

describe("PUT /api/profiles/[id]/connector-filters", () => {
  it("401 without a valid admin key", async () => {
    const res = await PUT(putReq({ connector: "idealista", url: IDEALISTA_URL }), ctx);
    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400 when connector is missing", async () => {
    const res = await PUT(putReq({ url: IDEALISTA_URL }, { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400 for a connector that admits no pinned URL (registry override_host_suffix NULL)", async () => {
    // Default mock returns null → not a capture portal and not a tunable HTTP
    // connector (e.g. cimenta2, or an unknown name).
    const res = await PUT(
      putReq({ connector: "cimenta2", url: "https://inmuebles.cimenta2.com/x" }, { adminKey: ADMIN_KEY }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no admite fijar");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("accepts a tunable HTTP connector validated against the registry host suffix", async () => {
    mockOverrideHostSuffix.mockResolvedValue("fotocasa.es");
    mockGetProfile.mockResolvedValue(ACTIVE_PROFILE);
    const url = "https://www.fotocasa.es/es/comprar/viviendas/sevilla-capital/todas-las-zonas/l";
    const stored = { id: 2, profile_id: 7, connector: "fotocasa", section_key: "", url, source: "manual", created_at: "x", updated_at: "x" };
    mockUpsert.mockResolvedValue(stored as never);
    const res = await PUT(putReq({ connector: "fotocasa", url }, { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(200);
    expect(mockOverrideHostSuffix).toHaveBeenCalledWith("fotocasa");
    expect(mockUpsert).toHaveBeenCalledWith({
      profileId: 7,
      connector: "fotocasa",
      sectionKey: "",
      url,
      source: "manual",
    });
  });

  it("400 when a tunable HTTP connector's URL host is foreign to its registry suffix", async () => {
    mockOverrideHostSuffix.mockResolvedValue("fotocasa.es");
    const res = await PUT(
      putReq({ connector: "fotocasa", url: "https://www.pisos.com/venta/pisos-sevilla/" }, { adminKey: ADMIN_KEY }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400 on a non-http(s) scheme", async () => {
    const res = await PUT(
      putReq({ connector: "idealista", url: "javascript://idealista.com/x" }, { adminKey: ADMIN_KEY }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400 on a foreign host", async () => {
    const res = await PUT(
      putReq({ connector: "idealista", url: "https://www.alisedainmobiliaria.com/x" }, { adminKey: ADMIN_KEY }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400 on a look-alike host that only ends near the connector domain", async () => {
    const res = await PUT(
      putReq({ connector: "idealista", url: "https://idealista.com.evil.example/x" }, { adminKey: ADMIN_KEY }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("404 when the profile is archived", async () => {
    mockGetProfile.mockResolvedValue({ id: 7, archived_at: "2026-01-01T00:00:00Z" } as never);
    const res = await PUT(putReq({ connector: "idealista", url: IDEALISTA_URL }, { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("404 when the profile does not exist", async () => {
    mockGetProfile.mockResolvedValue(null);
    const res = await PUT(putReq({ connector: "idealista", url: IDEALISTA_URL }, { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(404);
  });

  it("persists (upserts) a valid idealista override, url verbatim, source manual by default", async () => {
    mockGetProfile.mockResolvedValue(ACTIVE_PROFILE);
    const stored = { id: 1, profile_id: 7, connector: "idealista", section_key: "", url: IDEALISTA_URL, source: "manual", created_at: "x", updated_at: "x" };
    mockUpsert.mockResolvedValue(stored as never);
    const res = await PUT(putReq({ connector: "idealista", url: IDEALISTA_URL }, { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, row: stored });
    expect(mockUpsert).toHaveBeenCalledWith({
      profileId: 7,
      connector: "idealista",
      sectionKey: "",
      url: IDEALISTA_URL, // verbatim (shape= intact)
      source: "manual",
    });
  });

  it("honours an explicit sectionKey and source=extension", async () => {
    mockGetProfile.mockResolvedValue(ACTIVE_PROFILE);
    mockUpsert.mockResolvedValue({} as never);
    await PUT(
      putReq(
        { connector: "idealista", sectionKey: "venta-viviendas", url: IDEALISTA_URL, source: "extension" },
        { adminKey: ADMIN_KEY },
      ),
      ctx,
    );
    expect(mockUpsert).toHaveBeenCalledWith({
      profileId: 7,
      connector: "idealista",
      sectionKey: "venta-viviendas",
      url: IDEALISTA_URL,
      source: "extension",
    });
  });
});

describe("DELETE /api/profiles/[id]/connector-filters", () => {
  it("401 without a valid admin key", async () => {
    const res = await DELETE(deleteReq("?connector=idealista"), ctx);
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("400 when connector is missing", async () => {
    const res = await DELETE(deleteReq("", { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("204-style success when a row is deleted", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await DELETE(deleteReq("?connector=idealista", { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: true });
    expect(mockDelete).toHaveBeenCalledWith(7, "idealista", "");
  });

  it("404 when nothing matched", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await DELETE(deleteReq("?connector=idealista&sectionKey=venta-viviendas", { adminKey: ADMIN_KEY }), ctx);
    expect(res.status).toBe(404);
    expect(mockDelete).toHaveBeenCalledWith(7, "idealista", "venta-viviendas");
  });
});
