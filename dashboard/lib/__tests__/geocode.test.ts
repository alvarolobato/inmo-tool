import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchPlaces,
  GeocodeError,
  checkRateLimit,
  __resetGeocodeStateForTests,
} from "../geocode";

describe("searchPlaces", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    __resetGeocodeStateForTests();
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

  // --- Rate limiting / caching (Opus review, PR #103) -------------------
  // Nominatim's usage policy caps requests at 1/second, and a client-side
  // debounce alone can't guarantee this is respected (multiple tabs,
  // retries, or the route being hit directly all bypass it) — these tests
  // prove the server-side guarantees are real, not just present in code.

  it("throttles two rapid outbound requests to at least ~1.1s apart", async () => {
    vi.useFakeTimers();
    try {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const first = searchPlaces("query one");
      const second = searchPlaces("query two"); // different query - no cache hit

      // First call should resolve promptly; fetch called once so far.
      await vi.advanceTimersByTimeAsync(0);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Advancing by less than the minimum spacing shouldn't fire the
      // second request yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Advancing past the ~1.1s minimum spacing lets the second through.
      await vi.advanceTimersByTimeAsync(700);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      await Promise.all([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches an identical query so a second call doesn't hit Nominatim again", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        { lat: "40.1", lon: "-3.1", display_name: "Cached place" },
      ],
    });

    const first = await searchPlaces("Repeated Query");
    const second = await searchPlaces("repeated query"); // case/whitespace-insensitive cache key

    expect(first).toEqual(second);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    __resetGeocodeStateForTests();
  });

  it("allows requests under the per-window bucket and rejects once exceeded", () => {
    const ip = "203.0.113.1";
    // 20 requests/10s window is the current configured bucket size.
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(ip)).toBe(true);
    }
    expect(checkRateLimit(ip)).toBe(false);
  });

  it("tracks separate IPs independently", () => {
    for (let i = 0; i < 20; i++) checkRateLimit("203.0.113.1");
    expect(checkRateLimit("203.0.113.1")).toBe(false);
    expect(checkRateLimit("203.0.113.2")).toBe(true);
  });
});
