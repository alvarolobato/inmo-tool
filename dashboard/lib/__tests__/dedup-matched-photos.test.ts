/**
 * Unit tests for the pure matched-photo resolution helpers added for issue
 * #615 (`dashboard/lib/dedup-shared.ts`). DB-free — these functions take
 * plain objects, so this file runs under plain `npm test`, no
 * REQUIRE_DB=1 needed. Complements:
 *   - etl/tests/test_dedup_signals_photo_hash.py::TestMatchedPairs — proves
 *     the perceptual-hash matching itself picks the true pair, not index 0.
 *   - dashboard/e2e/mobile-dedup.spec.ts's dedicated #615 test — proves the
 *     full rendering pipeline (ListingSidePanel's cap/expand/badges) against
 *     a real page.
 * This file is the middle layer: given a `detail.matched_photos` payload
 * (as etl persists it) and two sides' `photo_urls`, does the dashboard
 * resolve/order them correctly? Deliberately uses fixtures where the
 * matching photo is NOT at index 0 on either side — a same-index fixture
 * would pass even if `resolveMatchedPhotos`/`orderPhotosMatchedFirst` did
 * nothing at all.
 */
import { describe, it, expect } from "vitest";
import { orderPhotosMatchedFirst, parseMatchedPhotos, resolveMatchedPhotos } from "@/lib/dedup-shared";

describe("parseMatchedPhotos", () => {
  it("returns [] when detail carries no matched_photos key (every non-photo_hash basis, and pre-#615 rows)", () => {
    expect(parseMatchedPhotos({})).toEqual([]);
    expect(parseMatchedPhotos({ match_ratio: 1.0 })).toEqual([]);
  });

  it("returns [] for a malformed shape rather than throwing", () => {
    expect(parseMatchedPhotos({ matched_photos: "not an array" })).toEqual([]);
    expect(parseMatchedPhotos({ matched_photos: [{ url_a: "x" }] })).toEqual([]);
    expect(parseMatchedPhotos({ matched_photos: [null, 42, { url_a: "a", url_b: "b", distance: "not a number" }] })).toEqual(
      [],
    );
  });

  it("parses a well-formed payload exactly as etl persists it", () => {
    const detail = {
      match_ratio: 1.0,
      matched_photos: [
        { url_a: "https://a.example/5.jpg", url_b: "https://b.example/9.jpg", distance: 0 },
      ],
    };
    expect(parseMatchedPhotos(detail)).toEqual([
      { url_a: "https://a.example/5.jpg", url_b: "https://b.example/9.jpg", distance: 0 },
    ]);
  });
});

describe("resolveMatchedPhotos", () => {
  it("pins url_a/url_b to lo/hi via membership, NOT storage order or key name — the match is at a non-zero index on both sides", () => {
    // Side "lo" has 6 photos, the true match at index 5 (last one).
    const loUrls = Array.from({ length: 6 }, (_, i) => `https://lo.example/${i}.jpg`);
    // Side "hi" has 14 photos, the true match at index 9.
    const hiUrls = Array.from({ length: 14 }, (_, i) => `https://hi.example/${i}.jpg`);
    const detail = {
      matched_photos: [{ url_a: loUrls[5], url_b: hiUrls[9], distance: 0 }],
    };

    const resolved = resolveMatchedPhotos(detail, { photo_urls: loUrls }, { photo_urls: hiUrls });

    expect(resolved).toEqual([{ urlLo: loUrls[5], urlHi: hiUrls[9], distance: 0 }]);
  });

  it("resolves correctly even when url_a/url_b are stored in the OPPOSITE order (hi first, lo second)", () => {
    // etl's evaluate_pair(a, b, ...) has no guaranteed relationship to
    // this group's canonical lo/hi order — url_a could be either side.
    const loUrls = ["https://lo.example/0.jpg", "https://lo.example/1.jpg"];
    const hiUrls = ["https://hi.example/0.jpg", "https://hi.example/1.jpg"];
    const detail = {
      // url_a is the HI-side URL here, url_b is the LO-side URL.
      matched_photos: [{ url_a: hiUrls[1], url_b: loUrls[0], distance: 3 }],
    };

    const resolved = resolveMatchedPhotos(detail, { photo_urls: loUrls }, { photo_urls: hiUrls });

    expect(resolved).toEqual([{ urlLo: loUrls[0], urlHi: hiUrls[1], distance: 3 }]);
  });

  it("drops a pair whose URLs match neither side as expected (stale evidence) rather than mis-assigning it", () => {
    const detail = {
      matched_photos: [{ url_a: "https://gone.example/x.jpg", url_b: "https://also-gone.example/y.jpg", distance: 0 }],
    };
    const resolved = resolveMatchedPhotos(
      detail,
      { photo_urls: ["https://lo.example/0.jpg"] },
      { photo_urls: ["https://hi.example/0.jpg"] },
    );
    expect(resolved).toEqual([]);
  });

  it("sorts strongest match first regardless of persisted order", () => {
    const loUrls = ["https://lo.example/a.jpg", "https://lo.example/b.jpg"];
    const hiUrls = ["https://hi.example/a.jpg", "https://hi.example/b.jpg"];
    const detail = {
      matched_photos: [
        { url_a: loUrls[0], url_b: hiUrls[0], distance: 8 },
        { url_a: loUrls[1], url_b: hiUrls[1], distance: 1 },
      ],
    };
    const resolved = resolveMatchedPhotos(detail, { photo_urls: loUrls }, { photo_urls: hiUrls });
    expect(resolved.map((r) => r.distance)).toEqual([1, 8]);
  });
});

describe("orderPhotosMatchedFirst", () => {
  it("puts the matched photo first even though it sits at index 5 of 6 in storage order", () => {
    const allUrls = Array.from({ length: 6 }, (_, i) => `https://x.example/${i}.jpg`);
    const ordered = orderPhotosMatchedFirst(allUrls, [allUrls[5]]);

    expect(ordered[0]).toEqual({ url: allUrls[5], matched: true });
    // Every other photo follows, in its original order, all unmatched.
    expect(ordered.slice(1)).toEqual(
      [0, 1, 2, 3, 4].map((i) => ({ url: allUrls[i], matched: false })),
    );
  });

  it("never interleaves matched and unmatched by index — all matched, then all unmatched", () => {
    const allUrls = ["p0", "p1", "p2", "p3", "p4"];
    // Two matches, at indices 1 and 3 — not adjacent, not at the start.
    const ordered = orderPhotosMatchedFirst(allUrls, ["p3", "p1"]);
    expect(ordered.map((o) => o.url)).toEqual(["p3", "p1", "p0", "p2", "p4"]);
    expect(ordered.map((o) => o.matched)).toEqual([true, true, false, false, false]);
  });

  it("returns every photo unmatched when there are no matches", () => {
    const allUrls = ["p0", "p1"];
    expect(orderPhotosMatchedFirst(allUrls, [])).toEqual([
      { url: "p0", matched: false },
      { url: "p1", matched: false },
    ]);
  });

  it("skips a matched URL that isn't actually in allUrls, rather than fabricating a photo", () => {
    const allUrls = ["p0", "p1"];
    const ordered = orderPhotosMatchedFirst(allUrls, ["not-a-real-photo"]);
    expect(ordered).toEqual([
      { url: "p0", matched: false },
      { url: "p1", matched: false },
    ]);
  });
});
