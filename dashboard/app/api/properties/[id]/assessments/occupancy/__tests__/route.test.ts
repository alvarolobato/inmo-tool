// @vitest-environment node
/**
 * Occupancy assessment route — route-level tests (#30 review, "also fix":
 * no route-level tests existed for any of the four assessment endpoints,
 * despite this PR shipping a new response shape — `stale` on GET, the #30
 * cache-aware error mapping on POST).
 *
 * Mocks `@/lib/ai-assessment/occupancy` wholesale (same pattern as
 * `app/api/etl/runs/[id]/__tests__/route.test.ts` mocking `@/lib/db`) — this
 * file is about the ROUTE's status-code/JSON-shape contract, not about the
 * flow's own logic, which occupancy.test.ts/occupancy.integration.test.ts
 * already cover.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai-assessment/occupancy", () => ({
  assessPropertyOccupancy: vi.fn(),
  getOccupancyAssessment: vi.fn(),
  NoListingsError: class NoListingsError extends Error {
    constructor(propertyId: number) {
      super(`Property ${propertyId} has no live listings to assess.`);
      this.name = "NoListingsError";
    }
  },
  OCCUPANCY_PROMPT_VERSION: "occupancy/v1",
}));

import { GET, POST } from "../route";
import {
  assessPropertyOccupancy,
  getOccupancyAssessment,
  NoListingsError,
} from "@/lib/ai-assessment/occupancy";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NextRequest } from "next/server";
import { AssessmentParkedError } from "@/lib/ai-assessment/cache";

const mockAssess = vi.mocked(assessPropertyOccupancy);
const mockGet = vi.mocked(getOccupancyAssessment);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/properties/1/assessments/occupancy");
}

beforeEach(() => {
  mockAssess.mockReset();
  mockGet.mockReset();
});

describe("GET /api/properties/[id]/assessments/occupancy", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
  });

  it("returns 404 when nothing has ever been assessed", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("returns the cached verdict with stale:false when the prompt version is current", async () => {
    mockGet.mockResolvedValue({
      result: { occupancy: { status: "vacant" } },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "occupancy/v1",
      content_hash: "abc123",
      stale: false,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.result).toEqual({ occupancy: { status: "vacant" } });
    expect(body.current_prompt_version).toBe("occupancy/v1");
  });

  it("surfaces stale:true — the #30 skew fix — instead of 404ing after a prompt-version bump", async () => {
    mockGet.mockResolvedValue({
      result: { occupancy: { status: "tenanted" } },
      model: "test-model",
      generated_at: "2026-01-01T00:00:00Z",
      prompt_version: "occupancy/v0-old",
      content_hash: "abc123",
      stale: true,
    } as never);
    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.prompt_version).toBe("occupancy/v0-old");
  });

  it("returns 500 on an unexpected error", async () => {
    mockGet.mockRejectedValue(new Error("db exploded"));
    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/properties/[id]/assessments/occupancy", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await POST(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("runs the assessment and returns the result", async () => {
    mockAssess.mockResolvedValue({ occupancy: { status: "vacant" } } as never);
    const res = await POST(makeRequest(), makeContext("1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toEqual({ occupancy: { status: "vacant" } });
    expect(body.prompt_version).toBe("occupancy/v1");
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
    expect((await res.json()).code).toBe("LLM_BUDGET_EXCEEDED");
  });

  it("returns 503 when the LLM circuit breaker is open", async () => {
    mockAssess.mockRejectedValue(new CircuitBreakerOpenError());
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("LLM_CIRCUIT_OPEN");
  });

  it("returns 500 on an unexpected error", async () => {
    mockAssess.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("UNKNOWN");
  });

  // D-104: a parked flow is a deliberate cost guard. Before this mapping it
  // fell through to the generic 500, so "Evaluar" on a parked property was an
  // opaque server error with no way out.
  it("returns 409 ASSESSMENT_PARKED when the flow is parked, not 500", async () => {
    mockAssess.mockRejectedValue(
      new AssessmentParkedError(1, "occupancy", 3, "unparseable JSON"),
    );
    const res = await POST(makeRequest(), makeContext("1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ASSESSMENT_PARKED");
    // The operator needs to know why, and how to override.
    expect(body.error).toContain("3");
    expect(body.error).toContain("force=1");
  });
});
