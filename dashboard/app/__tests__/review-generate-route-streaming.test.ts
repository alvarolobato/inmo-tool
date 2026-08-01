/**
 * Unit tests for POST /api/review/generate — NDJSON streaming path.
 *
 * Tests the frame ordering and content-type for streaming responses,
 * and verifies the non-streaming fallback still returns JSON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn().mockResolvedValue({ rows: [], columns: [] }),
  ConnectionError: class ConnectionError extends Error {},
  QueryTimeoutError: class QueryTimeoutError extends Error {},
}));

vi.mock("@/lib/review-queries", () => ({
  executeReviewQueries: vi.fn().mockResolvedValue([]),
  formatAllResults: vi.fn().mockReturnValue("(no data)"),
  computeQueryFailureRate: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/review-prompts", () => ({
  buildReviewPrompt: vi.fn().mockReturnValue("sys prompt"),
}));

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  // generateReview and generateReviewWithProgress now return { content, message }
  const mockReviewResult = {
    content: {
      executive_summary: ["Resumen OK"],
      sections: [],
      action_items: [],
      data_quality_notes: [],
      generated_at: "2026-04-01T00:00:00.000Z",
    },
    message: "He generado la revisión semanal.",
  };
  return {
    ...actual,
    generateReview: vi.fn().mockResolvedValue(mockReviewResult),
    generateReviewWithProgress: vi.fn().mockResolvedValue(mockReviewResult),
    BudgetExceededError: actual.BudgetExceededError,
  };
});

vi.mock("@/lib/review-db", () => ({
  getLatestReviewIdForWeek: vi.fn().mockResolvedValue(null),
  getMaxRevisionForWeek: vi.fn().mockResolvedValue(0),
  saveReview: vi.fn().mockResolvedValue(42),
}));

vi.mock("@/lib/review-actions-db", () => ({
  replaceActionsFromReviewContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/lib/review-dashboard-seed", () => ({
  getOrCreateReviewDashboardId: vi.fn().mockResolvedValue(99),
}));

vi.mock("@/lib/review-dashboard-links", () => ({
  addDaysIso: vi.fn().mockImplementation((date: string, days: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }),
  buildDashboardReviewHref: vi.fn().mockReturnValue("/dashboard/99?week=2026-03-31"),
}));

vi.mock("@/lib/review-evidence", () => ({
  enrichReviewContent: vi.fn().mockImplementation((content: unknown) => content),
  computeQueryFailureRate: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/review-schema", () => ({
  REVIEW_DASHBOARD_KEYS: ["ventas_retail"],
}));

import { POST } from "../api/review/generate/route";
import { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/review/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readNdjsonFrames(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Record<string, unknown>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        frames.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        // skip
      }
    }
  }
  if (buf.trim()) {
    try {
      frames.push(JSON.parse(buf.trim()) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return frames;
}

describe("POST /api/review/generate — streaming", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: no existing review for the week
    const { getLatestReviewIdForWeek } = vi.mocked(await import("@/lib/review-db"));
    getLatestReviewIdForWeek.mockResolvedValue(null);
    const { getMaxRevisionForWeek, saveReview } = vi.mocked(await import("@/lib/review-db"));
    getMaxRevisionForWeek.mockResolvedValue(0);
    saveReview.mockResolvedValue(42);
  });

  it("returns NDJSON stream with meta+phase+result frames", async () => {
    const res = await POST(makeRequest({ week_start: "2026-03-31", stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const frames = await readNdjsonFrames(res.body as ReadableStream<Uint8Array>);
    expect(frames.length).toBeGreaterThanOrEqual(3);

    const meta = frames.find((f) => f.type === "meta");
    expect(meta).toBeDefined();
    expect(meta?.weekStart).toBe("2026-03-31");

    const phaseFrames = frames.filter((f) => f.type === "phase");
    expect(phaseFrames.length).toBeGreaterThanOrEqual(1);

    const result = frames.find((f) => f.type === "result");
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)?.review).toBeDefined();
    const review = (result as Record<string, { id?: unknown }>)?.review;
    expect(review?.id).toBe(42);
    // New additive field: freeform chat message
    expect((result as Record<string, unknown>)?.message).toBe("He generado la revisión semanal.");
  });

  it("emits error frame when review already exists (409) is detected early", async () => {
    const reviewDbModule = await import("@/lib/review-db");
    vi.mocked(reviewDbModule.getLatestReviewIdForWeek).mockResolvedValue(5); // existing review

    // Without regenerate=true, a 409 JSON response is returned early (before streaming)
    const res = await POST(makeRequest({ week_start: "2026-03-31" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("REVIEW_EXISTS");
  });

  it("non-streaming path (stream:false) returns plain JSON", async () => {
    const res = await POST(makeRequest({ week_start: "2026-03-31", stream: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.review).toBeDefined();
    expect(body.review.id).toBe(42);
  });

  it("defaults to streaming (stream field unset)", async () => {
    const res = await POST(makeRequest({ week_start: "2026-03-31" }));
    expect(res.status).toBe(200);
    // Streaming response has NDJSON content-type
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  });
});
