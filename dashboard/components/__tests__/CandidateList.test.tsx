// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CandidateList } from "../candidates/CandidateList";
import type { CandidateRow } from "@/lib/candidates";

/**
 * Unit coverage for CandidateList's #592 infinite-scroll state machine
 * (review #597, "also fix": CandidateList had zero unit tests — every bit of
 * #592's fetch/guard logic rode on a single e2e spec). These two tests target
 * exactly the two things e2e can only prove indirectly:
 *
 *   1. The in-flight REF guard actually stops a re-intersecting sentinel from
 *      double-fetching — simulated by invoking the (faked)
 *      IntersectionObserver callback twice SYNCHRONOUSLY, before the first
 *      fetch's promise resolves, which a real click-based test can't
 *      reproduce (a disabled <button> already blocks a second click on its
 *      own — the guard exists for the sentinel, which has no such native
 *      protection).
 *   2. A failed page-2+ fetch surfaces a scoped, retryable error WITHOUT
 *      wiping the already-loaded page-1 items.
 *
 * CandidateCard is mocked out (a thin, fetch-heavy component in its own
 * right — FeedbackControls does its own GET per card) so these tests stay
 * fast and scoped to CandidateList's own logic, not its children's.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("../candidates/CandidateCard", () => ({
  CandidateCard: ({ candidate }: { candidate: CandidateRow }) => (
    <div data-testid="candidate-card" data-property-id={candidate.property_id} />
  ),
}));

// A minimal fake of the browser API, capturing the callback CandidateList's
// sentinel effect registers so a test can fire it manually — jsdom has no
// real IntersectionObserver, and even a polyfill wouldn't let a test force
// two SYNCHRONOUS intersections the way a real scroll never could.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  /** Fire the registered callback as if the sentinel just intersected. */
  trigger() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function makeCandidate(id: number): CandidateRow {
  return {
    property_id: id,
    address: `Calle Test ${id}`,
    lat: null,
    lon: null,
    property_type: "piso",
    m2_built: 70,
    rooms: 2,
    bathrooms: 1,
    floor: null,
    photos: [],
    flags: [],
    min_price: 200000,
    first_seen_at: null,
    is_new: false,
    price_changed: false,
    price_delta_pct: null,
    price_direction: null,
    last_seen_at: null,
    listings: [],
    score: null,
    rank_explanation: null,
    score_kind: null,
    effective_score: null,
    below_market_pct: null,
    below_market_base: null,
    below_market_comparables: null,
    distress_level: 0,
    ranking_boost_reason: null,
    feedback_state: null,
  };
}

type MockResponse = { ok: boolean; json: () => Promise<unknown> };

function okPage(items: CandidateRow[], nextCursor: string | null): MockResponse {
  return { ok: true, json: async () => ({ items, nextCursor, coldStart: false }) };
}

/**
 * URL-dispatching fetch stub (same pattern as ConversationPane.test.tsx's
 * stubFetch). `page1` answers the initial (no-cursor) candidates fetch;
 * `page2` answers any cursor-bearing one — a function so a test can return a
 * controlled (not-yet-resolved) promise, or an error response.
 */
function stubFetch(opts: {
  page1: CandidateRow[];
  page1NextCursor: string | null;
  page2: () => Promise<MockResponse>;
}) {
  const cursorCalls: string[] = [];
  const fetchMock = vi.fn().mockImplementation((rawUrl: string) => {
    const url = rawUrl as string;
    if (url.includes("/candidate-sources")) {
      return Promise.resolve({ ok: true, json: async () => ({ sources: [] }) });
    }
    if (url.includes("/seguimiento-alerts")) {
      return Promise.resolve({ ok: true, json: async () => ({ count: 0 }) });
    }
    if (url.includes("/candidates")) {
      if (url.includes("cursor=")) {
        cursorCalls.push(url);
        return opts.page2();
      }
      return Promise.resolve(okPage(opts.page1, opts.page1NextCursor));
    }
    // FeedbackControls' own GET (harmless catch-all — not under test here).
    return Promise.resolve({ ok: true, json: async () => ({ currentState: null }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, cursorCalls };
}

// #633: page-1 rendering (the card appearing) and the sentinel's
// IntersectionObserver being CONSTRUCTED are two separate async events —
// the card commits when `items`/`loading` update, but the sentinel only
// exists once `cursor` is also non-null, and the observer itself attaches
// from a `useEffect` that React schedules as a passive effect, not
// synchronously with that commit. Waiting only for the card (the original
// version of this helper) raced the two: under CI load the assertion could
// run before the effect had constructed the observer, producing "no
// IntersectionObserver instance was created" — timing-shaped, not random,
// same species as #539's cross-round-trip race even though the mechanism
// (React effect scheduling vs a Playwright CDP round trip) differs. Waiting
// explicitly for the observer to exist closes the gap instead of relying on
// incidental timing.
async function renderAndWaitForPageOne() {
  render(<CandidateList profileId={1} />);
  await waitFor(() => expect(screen.getAllByTestId("candidate-card")).toHaveLength(1));
  await waitFor(() => expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0));
}

function latestSentinelObserver(): FakeIntersectionObserver {
  const instance =
    FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
  if (!instance) {
    throw new Error(
      "no IntersectionObserver instance was created — renderAndWaitForPageOne should have " +
        "waited for one; call it before reaching for the sentinel observer",
    );
  }
  return instance;
}

describe("CandidateList infinite scroll (#592)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it("the sentinel's in-flight ref guard stops a double-fire: two synchronous intersections before the first fetch resolves produce exactly ONE page-2 request", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    let resolvePage2!: (v: MockResponse) => void;
    const page2Promise = new Promise<MockResponse>((resolve) => {
      resolvePage2 = resolve;
    });
    const { cursorCalls } = stubFetch({
      page1: [makeCandidate(1)],
      page1NextCursor: "cursor-1",
      page2: () => page2Promise,
    });

    await renderAndWaitForPageOne();

    const observer = latestSentinelObserver();
    // Two intersections back-to-back, synchronously — no await between them,
    // exactly the re-intersecting-sentinel failure mode the guard exists for.
    observer.trigger();
    observer.trigger();

    // Only the FIRST one actually started a fetch — the second saw
    // `loadingMoreRef.current === true` (set synchronously, before any
    // await) and no-opped.
    expect(cursorCalls).toHaveLength(1);

    resolvePage2(okPage([makeCandidate(2)], null));
    await waitFor(() => expect(screen.getAllByTestId("candidate-card")).toHaveLength(2));

    // Still exactly one page-2 request after the fetch actually completed —
    // no queued/skipped duplicate fired late either.
    expect(cursorCalls).toHaveLength(1);
  });

  it("a failed page-2 fetch shows a scoped, retryable error and leaves the already-loaded page-1 items on screen", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const { cursorCalls } = stubFetch({
      page1: [makeCandidate(1)],
      page1NextCursor: "cursor-1",
      page2: () =>
        Promise.resolve({
          ok: false,
          json: async () => ({
            error: "fallo simulado",
            code: "INTERNAL",
            timestamp: new Date().toISOString(),
            requestId: "test",
          }),
        }),
    });

    await renderAndWaitForPageOne();
    latestSentinelObserver().trigger();

    await waitFor(() => expect(screen.getByTestId("error-display")).toBeInTheDocument());
    // Page-1's item is still there — a page-2+ failure must not wipe the
    // feed the way a page-1 failure legitimately does.
    expect(screen.getAllByTestId("candidate-card")).toHaveLength(1);
    expect(screen.getByTestId("retry-button")).toBeInTheDocument();
    expect(cursorCalls).toHaveLength(1);
  });
});
