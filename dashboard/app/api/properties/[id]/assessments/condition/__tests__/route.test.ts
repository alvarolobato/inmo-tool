// @vitest-environment node
/**
 * Condition assessment route — route-level tests (#30 review, "also fix"
 * — see occupancy's route.test.ts for the full rationale; this file mirrors
 * it exactly for the condition endpoint).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock: keep the real AssessmentParkedError class (the route maps on
// `instanceof`) while making the ledger clear observable without a database.
vi.mock("@/lib/ai-assessment/cache", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  clearAssessmentFailures: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ai-assessment/condition", () => ({
  assessPropertyCondition: vi.fn(),
  getConditionAssessment: vi.fn(),
  NoListingsError: class NoListingsError extends Error {
    constructor(propertyId: number) {
      super(`Property ${propertyId} has no live listings to assess.`);
      this.name = "NoListingsError";
    }
  },
  CONDITION_PROMPT_VERSION: "condition/v1",
}));

import { GET, POST } from "../route";
import {
  assessPropertyCondition,
  getConditionAssessment,
  NoListingsError,
} from "@/lib/ai-assessment/condition";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NextRequest } from "next/server";
import { AssessmentParkedError } from "@/lib/ai-assessment/cache";
import { clearAssessmentFailures } from "@/lib/ai-assessment/cache";

const mockClearFailures = vi.mocked(clearAssessmentFailures);

const mockAssess = vi.mocked(assessPropertyCondition);
const mockGet = vi.mocked(getConditionAssessment);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/properties/1/assessments/condition");
}

beforeEach(() => {
  mockAssess.mockReset();
  mockGet.mockReset();
  mockClearFailures.mockClear();
});

describe("GET /api/properties/[id]/assessments/condition", () => {
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
      result: { condition: "reformado" },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "condition/v1",
      content_hash: "abc123",
      stale: false,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.result).toEqual({ condition: "reformado" });
  });

  it("surfaces stale:true instead of 404ing after a prompt-version bump", async () => {
    mockGet.mockResolvedValue({
      result: { condition: "a_reformar" },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "condition/v0-old",
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

describe("POST /api/properties/[id]/assessments/condition", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await POST(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("runs the assessment and returns the result", async () => {
    mockAssess.mockResolvedValue({ condition: "reformado" } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toEqual({ condition: "reformado" });
    expect(body.prompt_version).toBe("condition/v1");
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

  // D-104: a parked flow is a deliberate cost guard. Before this mapping it
  // fell through to the generic 500, so "Evaluar" on a parked property was an
  // opaque server error with no way out.
  it("returns 409 ASSESSMENT_PARKED when the flow is parked, not 500", async () => {
    mockAssess.mockRejectedValue(
      new AssessmentParkedError(1, "condition", 3, "unparseable JSON"),
    );
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ASSESSMENT_PARKED");
    // The operator needs to know why, and how to override.
    expect(body.error).toContain("3");
    expect(body.error).toContain("force=1");
  });

  it("does not touch the ledger without ?force=1", async () => {
    mockAssess.mockResolvedValue({ condition: "a_reformar" } as never);
    await POST(makeRequest(), makeContext("1"));
    expect(mockClearFailures).not.toHaveBeenCalled();
  });

  it("?force=1 clears the ledger first, so a parked flow can be overridden", async () => {
    mockAssess.mockResolvedValue({ condition: "a_reformar" } as never);
    const res = await POST(
      new NextRequest("http://localhost:4000/api/properties/1/assessments/condition?force=1"),
      makeContext("1"),
    );
    expect(res.status).toBe(200);
    expect(mockClearFailures).toHaveBeenCalledWith(1, "condition", "condition/v1");
  });
});
