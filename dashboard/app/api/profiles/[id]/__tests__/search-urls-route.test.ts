// @vitest-environment node
/**
 * Unit tests for GET /api/profiles/[id]/search-urls (issue #267).
 *
 * Mocks the DB access (getProfileById) so no real Postgres connection is
 * needed — the route's job is only to fetch the profile and hand its scope to
 * the pure search-URL builder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/profiles", () => ({
  getProfileById: vi.fn(),
}));

import { GET } from "../search-urls/route";
import * as profiles from "@/lib/db/profiles";
import type { SearchProfileRow } from "@/lib/profiles-schema";

const mockGet = vi.mocked(profiles.getProfileById);

function makeProfile(): SearchProfileRow {
  return {
    id: 7,
    name: "Centro Madrid",
    scope: {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 8 },
      property_types: ["piso"],
      price_max: 250000,
      hard_exclusions: {},
    },
    thesis_params: {},
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_materialized_at: null,
    last_viewed_at: null,
  };
}

function req(id = "7"): NextRequest {
  return new NextRequest(`http://localhost:4000/api/profiles/${id}/search-urls`);
}

function ctx(id = "7") {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/profiles/[id]/search-urls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a flat list of pre-filtered search tasks for the profile scope", async () => {
    mockGet.mockResolvedValue(makeProfile());
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profileId).toBe(7);
    expect(body.name).toBe("Centro Madrid");
    // A single-piso profile → one idealista task + one aliseda task.
    expect(body.tasks.map((t: { portal: string }) => t.portal)).toEqual(["idealista", "aliseda"]);
    for (const t of body.tasks) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.label).toBe("string");
    }
    const idealista = body.tasks.find((t: { portal: string }) => t.portal === "idealista");
    expect(idealista.url).toContain("idealista.com/venta-viviendas");
    expect(idealista.url).toContain("precio-hasta_250000");
  });

  it("400 on a non-numeric id", async () => {
    const res = await GET(req("abc"), ctx("abc"));
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("404 when the profile does not exist", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(req("999"), ctx("999"));
    expect(res.status).toBe(404);
  });

  it("500 when the DB read throws", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(500);
  });
});
