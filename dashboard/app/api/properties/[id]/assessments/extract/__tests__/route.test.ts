// @vitest-environment node
/**
 * Extract assessment route — route-level tests (#30 review, "also fix" —
 * see occupancy's route.test.ts for the shared rationale). This route is the
 * one with the genuinely NEW response shape the review calls out
 * specifically: POST can return `{skipped: true, reason}` with a 200 (not an
 * error) when EC-3's cost-control gate finds nothing left to fill in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai-assessment/extract", () => ({
  assessPropertyExtract: vi.fn(),
  getExtractAssessment: vi.fn(),
  NoListingsError: class NoListingsError extends Error {
    constructor(propertyId: number) {
      super(`Property ${propertyId} has no live listings to assess.`);
      this.name = "NoListingsError";
    }
  },
  EXTRACT_PROMPT_VERSION: "extract/v1",
}));

import { GET, POST } from "../route";
import {
  assessPropertyExtract,
  getExtractAssessment,
  NoListingsError,
} from "@/lib/ai-assessment/extract";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NextRequest } from "next/server";

const mockAssess = vi.mocked(assessPropertyExtract);
const mockGet = vi.mocked(getExtractAssessment);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/properties/1/assessments/extract");
}

beforeEach(() => {
  mockAssess.mockReset();
  mockGet.mockReset();
});

describe("GET /api/properties/[id]/assessments/extract", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when nothing has ever been extracted", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("returns the cached extraction with stale:false when current", async () => {
    mockGet.mockResolvedValue({
      result: { rooms: 3, m2_built: 90 },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "extract/v1",
      content_hash: "abc123",
      stale: false,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.result.rooms).toBe(3);
  });

  it("surfaces stale:true instead of 404ing after a prompt-version bump", async () => {
    mockGet.mockResolvedValue({
      result: { rooms: 3, m2_built: 90 },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "extract/v0-old",
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

describe("POST /api/properties/[id]/assessments/extract", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await POST(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("runs the extraction and returns skipped:false with the result", async () => {
    mockAssess.mockResolvedValue({ skipped: false, result: { rooms: 3, m2_built: 90 } } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(false);
    expect(body.result.rooms).toBe(3);
    expect(body.prompt_version).toBe("extract/v1");
  });

  it("returns 200 with skipped:true (NOT an error) when EC-3's cost-control gate finds nothing left to fill", async () => {
    mockAssess.mockResolvedValue({
      skipped: true,
      reason: "La propiedad ya tiene todos los campos estructurados que este flujo puede rellenar.",
    } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.reason).toContain("ya tiene todos los campos");
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
