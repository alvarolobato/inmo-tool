import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPlaces, GeocodeError } from "../geocode";

describe("searchPlaces", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns [] without calling Nominatim for a too-short query", async () => {
    const results = await searchPlaces("ab");
    expect(results).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends a real identifying User-Agent header, per Nominatim's usage policy", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await searchPlaces("Chamberí, Madrid");

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/inmo-tool/);
  });

  it("parses a real-shaped Nominatim response into GeocodeResult[]", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          place_id: 291715091,
          lat: "40.4389621",
          lon: "-3.7053020",
          display_name: "Chamberí, Madrid, Comunidad de Madrid, España",
        },
      ],
    });

    const results = await searchPlaces("Chamberí");

    expect(results).toEqual([
      { label: "Chamberí, Madrid, Comunidad de Madrid, España", lat: 40.4389621, lon: -3.705302 },
    ]);
  });

  it("skips malformed entries instead of throwing", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        { lat: "not-a-number", lon: "-3.7", display_name: "Bad entry" },
        { lat: "40.1", lon: "-3.1", display_name: "Good entry" },
      ],
    });

    const results = await searchPlaces("test");

    expect(results).toEqual([{ label: "Good entry", lat: 40.1, lon: -3.1 }]);
  });

  it("throws GeocodeError on a non-OK response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => [],
    });

    await expect(searchPlaces("test")).rejects.toThrow(GeocodeError);
  });

  it("throws GeocodeError when Nominatim returns a non-array body", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ error: "not an array" }),
    });

    await expect(searchPlaces("test")).rejects.toThrow(GeocodeError);
  });

  it("throws a distinct timeout message on abort", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    await expect(searchPlaces("test")).rejects.toThrow(/tardado demasiado/);
  });
});
