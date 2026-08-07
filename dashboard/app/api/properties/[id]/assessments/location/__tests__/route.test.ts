// @vitest-environment node
/**
 * Location assessment route — route-level tests (#400). Mirrors the redflags
 * route test exactly, plus the location-only `skipped` outcome (a `terreno`
 * plot the axis doesn't apply to — see lib/ai-assessment/location.ts).
 *
 * Admin-auth (401 without the credential) is enforced centrally by
 * middleware.ts for every `/api/*` path and asserted by
 * `dashboard/__tests__/api-auth-coverage.test.ts`; it is not re-tested at the
 * route-unit level here (same as every other assessments route test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai-assessment/location", () => ({
  assessPropertyLocation: vi.fn(),
  getLocationAssessment: vi.fn(),
  NoListingsError: class NoListingsError extends Error {
    constructor(propertyId: number) {
      super(`Property ${propertyId} has no live listings to assess.`);
      this.name = "NoListingsError";
    }
  },
  LOCATION_PROMPT_VERSION: "location/v1",
}));

import { GET, POST } from "../route";
import {
  assessPropertyLocation,
  getLocationAssessment,
  NoListingsError,
} from "@/lib/ai-assessment/location";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NextRequest } from "next/server";

const mockAssess = vi.mocked(assessPropertyLocation);
const mockGet = vi.mocked(getLocationAssessment);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/properties/1/assessments/location");
}

const SAMPLE_RESULT = {
  beach_proximity: "frontline",
  beach_evidence: "primera línea de playa",
  beach_evidence_source: "idealista",
  heritage_zone: false,
  heritage_evidence: "",
  heritage_evidence_source: null,
  confidence: 0.8,
  reasoning: "",
};

beforeEach(() => {
  mockAssess.mockReset();
  mockGet.mockReset();
});

describe("GET /api/properties/[id]/assessments/location", () => {
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
      result: SAMPLE_RESULT,
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "location/v1",
      content_hash: "abc123",
      stale: false,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.result.beach_proximity).toBe("frontline");
  });

  it("surfaces stale:true instead of 404ing after a prompt-version bump", async () => {
    mockGet.mockResolvedValue({
      result: SAMPLE_RESULT,
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "location/v0-old",
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

describe("POST /api/properties/[id]/assessments/location", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await POST(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("runs the assessment and returns the result", async () => {
    mockAssess.mockResolvedValue({ skipped: false, result: SAMPLE_RESULT } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockAssess).toHaveBeenCalledWith(1, expect.objectContaining({ requestId: expect.any(String) }));
    expect(body.result.beach_proximity).toBe("frontline");
    expect(body.prompt_version).toBe("location/v1");
  });

  it("returns 200 with skipped:true for a terreno the axis doesn't apply to", async () => {
    mockAssess.mockResolvedValue({ skipped: true, reason: "no aplica a un terreno" } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.reason).toContain("terreno");
    expect(body.result).toBeUndefined();
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
