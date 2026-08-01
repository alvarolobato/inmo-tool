import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mockQuery }));

import { parseSeason } from "@/lib/seasons";
import { GET } from "../route";

describe("parseSeason", () => {
  it("maps PV26 to Primavera-Verano with correct dates", () => {
    const s = parseSeason("PV26");
    expect(s).toEqual({
      code: "PV26",
      label: "Primavera-Verano 2026",
      from: "2026-02-01",
      to: "2026-08-31",
    });
  });

  it("maps OI25 to Otono-Invierno spanning two years", () => {
    const s = parseSeason("OI25");
    expect(s).toEqual({
      code: "OI25",
      label: "Otoño-Invierno 2025",
      from: "2025-09-01",
      to: "2026-01-31",
    });
  });

  it("returns null for unknown prefix", () => {
    expect(parseSeason("XX26")).toBeNull();
  });

  it("returns null for malformed code (no year digits)", () => {
    expect(parseSeason("PV")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSeason("")).toBeNull();
  });

  it("returns null for code with extra chars", () => {
    expect(parseSeason("PV2026")).toBeNull();
  });

  it("is case-insensitive", () => {
    const s = parseSeason("pv26");
    expect(s).not.toBeNull();
    expect(s?.label).toBe("Primavera-Verano 2026");
  });
});

describe("GET /api/seasons", () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it("returns seasons array from DB rows", async () => {
    mockQuery.mockResolvedValue({
      columns: ["clave_temporada"],
      rows: [["PV26"], ["OI25"], ["PV25"]],
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.seasons).toHaveLength(3);
    expect(body.seasons[0]).toEqual({
      code: "PV26",
      label: "Primavera-Verano 2026",
      from: "2026-02-01",
      to: "2026-08-31",
    });
  });

  it("excludes unknown/malformed codes", async () => {
    mockQuery.mockResolvedValue({
      columns: ["clave_temporada"],
      rows: [["PV26"], ["XX99"], [""], ["BADCODE"]],
    });
    const res = await GET();
    const body = await res.json();
    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0].code).toBe("PV26");
  });

  it("returns empty seasons array on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.seasons).toEqual([]);
  });
});
