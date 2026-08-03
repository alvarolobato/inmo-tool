// @vitest-environment node
/**
 * Redflags assessment route — route-level tests (#30 review, "also fix"
 * — see occupancy's route.test.ts for the full rationale; this file mirrors
 * it exactly for the redflags endpoint).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai-assessment/redflags", () => ({
  assessPropertyRedFlags: vi.fn(),
  getRedFlagsAssessment: vi.fn(),
  NoListingsError: class NoListingsError extends Error {
    constructor(propertyId: number) {
      super(`Property ${propertyId} has no live listings to assess.`);
      this.name = "NoListingsError";
    }
  },
  REDFLAGS_PROMPT_VERSION: "redflags/v1",
}));

import { GET, POST } from "../route";
import {
  assessPropertyRedFlags,
  getRedFlagsAssessment,
  NoListingsError,
} from "@/lib/ai-assessment/redflags";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NextRequest } from "next/server";

const mockAssess = vi.mocked(assessPropertyRedFlags);
const mockGet = vi.mocked(getRedFlagsAssessment);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/properties/1/assessments/redflags");
}

beforeEach(() => {
  mockAssess.mockReset();
  mockGet.mockReset();
});

describe("GET /api/properties/[id]/assessments/redflags", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when nothing has ever been assessed", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("returns the cached verdict with stale:false when current", async () => {
    mockGet.mockResolvedValue({
      result: { flags: [], confidence: 0.7 },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "redflags/v1",
      content_hash: "abc123",
      stale: false,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.result.flags).toEqual([]);
  });

  it("surfaces stale:true instead of 404ing after a prompt-version bump", async () => {
    mockGet.mockResolvedValue({
      result: { flags: [], confidence: 0.7 },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "redflags/v0-old",
      content_hash: "abc123",
      stale: true,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
  });

  it("returns 500 on an unexpected error", async () => {
    mockGet.mockRejectedValue(new Error("db exploded"));
    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/properties/[id]/assessments/redflags", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await POST(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("runs the assessment and returns the result", async () => {
    mockAssess.mockResolvedValue({ flags: [], confidence: 0.7 } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.flags).toEqual([]);
    expect(body.prompt_version).toBe("redflags/v1");
  });

  it("returns 404 (NoListingsError) when the property has no live listings", async () => {
    mockAssess.mockRejectedValue(new NoListingsError(1));
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("returns 429 when the daily LLM budget is exhausted", async () => {
    mockAssess.mockRejectedValue(new BudgetExceededError());
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(429);
  });

  it("returns 503 when the LLM circuit breaker is open", async () => {
    mockAssess.mockRejectedValue(new CircuitBreakerOpenError());
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(503);
  });

  it("returns 500 on an unexpected error", async () => {
    mockAssess.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});
