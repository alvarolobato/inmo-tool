// @vitest-environment node
/**
 * GET/POST /api/etl/worklist/recapture (issue #677).
 *
 * Auth is enforced by middleware's `/api/etl/:path*` matcher, not here, so
 * these tests are about the two things this route is actually responsible for:
 * keeping the predicate vocabulary closed, and refusing to perform a bulk
 * write that nobody agreed the size of.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/recapture", () => ({
  previewRecaptureCohort: vi.fn(),
  requeueRecaptureCohort: vi.fn(),
  isCaptureProcessingEnabled: vi.fn(),
}));

import { GET, POST } from "../route";
import * as db from "@/lib/db/recapture";

const mockPreview = vi.mocked(db.previewRecaptureCohort);
const mockRequeue = vi.mocked(db.requeueRecaptureCohort);
const mockCaptureEnabled = vi.mocked(db.isCaptureProcessingEnabled);

const BASE = "http://localhost:4000/api/etl/worklist/recapture";

function get(qs: string): NextRequest {
  return new NextRequest(`${BASE}?${qs}`);
}

function post(body: unknown): NextRequest {
  return new NextRequest(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = {
  portal: "idealista",
  predicate: "few_photos",
  threshold: 4,
  onlyLiveCandidates: true,
};

function previewOf(rowCount: number) {
  return {
    request: { ...VALID, predicate: "few_photos" as const },
    rowCount,
    listingCount: rowCount,
    alreadyRequeuedCount: 0,
    estimate: {
      seconds: 100,
      secondsPerListing: 10,
      storedHtmlBytes: 0,
      rawHtmlBytes: 0,
      htmlRetentionOn: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the ETL would process what a re-capture pass produces. The tests
  // that care flip it explicitly.
  mockCaptureEnabled.mockResolvedValue(true);
});

/** The same preview, but for a portal that is retaining capture HTML. */
function previewWithRetention(rowCount: number) {
  return {
    ...previewOf(rowCount),
    estimate: {
      seconds: 45_000,
      secondsPerListing: 16.1,
      storedHtmlBytes: 355_000_000,
      rawHtmlBytes: 1_400_000_000,
      htmlRetentionOn: true,
    },
  };
}

describe("GET (preview)", () => {
  it("returns the cohort preview for a valid request", async () => {
    mockPreview.mockResolvedValue(previewOf(2800));
    const res = await GET(
      get("portal=idealista&predicate=few_photos&threshold=4"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).rowCount).toBe(2800);
    expect(mockPreview).toHaveBeenCalledWith({
      portal: "idealista",
      predicate: "few_photos",
      threshold: 4,
      onlyLiveCandidates: true,
    });
  });

  it("defaults onlyLiveCandidates ON when the caller says nothing", async () => {
    // Re-capturing a listing nobody will look at is wasted browsing, so the
    // narrow cohort is the default and the wide one must be asked for.
    mockPreview.mockResolvedValue(previewOf(1));
    await GET(get("portal=idealista&predicate=few_photos&threshold=4"));
    expect(mockPreview.mock.calls[0][0].onlyLiveCandidates).toBe(true);
  });

  it("honours an explicit opt-out", async () => {
    mockPreview.mockResolvedValue(previewOf(1));
    await GET(
      get(
        "portal=idealista&predicate=few_photos&threshold=4&onlyLiveCandidates=false",
      ),
    );
    expect(mockPreview.mock.calls[0][0].onlyLiveCandidates).toBe(false);
  });

  it("rejects a portal the extension cannot capture", async () => {
    const res = await GET(
      get("portal=fotocasa&predicate=few_photos&threshold=4"),
    );
    expect(res.status).toBe(400);
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("rejects a predicate outside the closed set", async () => {
    for (const p of ["", "anything", "1=1", "few_photos%20OR%201"]) {
      const res = await GET(get(`portal=idealista&predicate=${p}&threshold=4`));
      expect(res.status).toBe(400);
    }
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("rejects a non-integer, zero, negative or absurd threshold", async () => {
    for (const t of ["", "0", "-1", "3.5", "abc", "999999"]) {
      const res = await GET(
        get(`portal=idealista&predicate=few_photos&threshold=${t}`),
      );
      expect(res.status).toBe(400);
    }
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("ignores the threshold for a predicate that takes none", async () => {
    mockPreview.mockResolvedValue(previewOf(3));
    const res = await GET(get("portal=idealista&predicate=never_requeued"));
    expect(res.status).toBe(200);
    expect(mockPreview.mock.calls[0][0].threshold).toBeNull();
  });

  it("surfaces a 500 when the cohort query throws", async () => {
    mockPreview.mockRejectedValue(new Error("boom"));
    const res = await GET(
      get("portal=idealista&predicate=few_photos&threshold=4"),
    );
    expect(res.status).toBe(500);
  });
});

describe("POST (requeue)", () => {
  it("requeues when the confirmed count still matches", async () => {
    mockRequeue.mockResolvedValue({ requeued: 2800, expected: 2800 });
    const res = await POST(
      post({ ...VALID, reason: "galería truncada", expectedCount: 2800 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, requeued: 2800 });
    expect(mockRequeue).toHaveBeenCalledWith(
      {
        portal: "idealista",
        predicate: "few_photos",
        threshold: 4,
        onlyLiveCandidates: true,
      },
      "galería truncada",
      2800,
    );
  });

  it("refuses a bulk write with no confirmed count", async () => {
    // The count is what the operator approved the SIZE of. Without it there is
    // no confirmation, only a request.
    for (const body of [
      { ...VALID, reason: "x" },
      { ...VALID, reason: "x", expectedCount: "many" },
      { ...VALID, reason: "x", expectedCount: -1 },
      { ...VALID, reason: "x", expectedCount: 1.5 },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it("refuses a requeue with no reason", async () => {
    for (const reason of [undefined, "", "   "]) {
      const res = await POST(post({ ...VALID, reason, expectedCount: 10 }));
      expect(res.status).toBe(400);
    }
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it("409s, and writes nothing, when the cohort moved since the preview", async () => {
    mockRequeue.mockResolvedValue({ requeued: 0, expected: 2795 });
    const res = await POST(
      post({ ...VALID, reason: "x", expectedCount: 2800 }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("2795");
  });

  it("does not 409 a genuinely empty cohort the operator confirmed", async () => {
    mockRequeue.mockResolvedValue({ requeued: 0, expected: 0 });
    const res = await POST(post({ ...VALID, reason: "x", expectedCount: 0 }));
    expect(res.status).toBe(200);
  });

  it("rejects bad JSON, an unknown portal and an unknown predicate", async () => {
    const bad = new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect((await POST(bad)).status).toBe(400);
    expect(
      (
        await POST(
          post({ ...VALID, portal: "fotocasa", reason: "x", expectedCount: 1 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          post({ ...VALID, predicate: "nope", reason: "x", expectedCount: 1 }),
        )
      ).status,
    ).toBe(400);
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it("surfaces a 500 when the write throws", async () => {
    mockRequeue.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ ...VALID, reason: "x", expectedCount: 1 }));
    expect(res.status).toBe(500);
  });
});

describe("the storage-cost passthrough", () => {
  it("hands the retention-on estimate to the client untouched", async () => {
    // The route must not round, clamp or reinterpret this — it is the number
    // the panel turns into the red "considera apagar la retención" warning,
    // and it is what stops a bulk pass tripling the database.
    mockPreview.mockResolvedValue(previewWithRetention(2800));
    const res = await GET(
      get("portal=idealista&predicate=few_photos&threshold=4"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estimate.htmlRetentionOn).toBe(true);
    expect(body.estimate.storedHtmlBytes).toBe(355_000_000);
    expect(body.estimate.rawHtmlBytes).toBe(1_400_000_000);
  });
});

describe("the capture_enabled guard (issue #263 / etl/capture.py)", () => {
  // `isCapturePortal` only says the EXTENSION can capture this portal. If
  // `connector_config.capture_enabled = false`, the ETL refuses to PROCESS
  // what comes back, so a 12-hour browsing session would produce rows that sit
  // pending forever.

  it("warns on the preview rather than refusing it (GET never writes)", async () => {
    mockPreview.mockResolvedValue(previewOf(2800));
    mockCaptureEnabled.mockResolvedValue(false);
    const res = await GET(
      get("portal=idealista&predicate=few_photos&threshold=4"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(2800);
    expect(body.captureProcessingEnabled).toBe(false);
  });

  it("reports the healthy case too, so the panel can stay quiet", async () => {
    mockPreview.mockResolvedValue(previewOf(10));
    const res = await GET(
      get("portal=idealista&predicate=few_photos&threshold=4"),
    );
    expect((await res.json()).captureProcessingEnabled).toBe(true);
  });

  it("refuses the write outright, and does not touch the database", async () => {
    mockCaptureEnabled.mockResolvedValue(false);
    const res = await POST(
      post({ ...VALID, reason: "galería truncada", expectedCount: 2800 }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/capture_enabled/);
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it("allows the write when capture processing is on", async () => {
    mockRequeue.mockResolvedValue({ requeued: 2800, expected: 2800 });
    const res = await POST(
      post({ ...VALID, reason: "galería truncada", expectedCount: 2800 }),
    );
    expect(res.status).toBe(200);
    expect(mockRequeue).toHaveBeenCalledTimes(1);
  });
});
