import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures the mock variable is available before vi.mock hoisting
const { mockSuggestDashboards } = vi.hoisted(() => ({
  mockSuggestDashboards: vi.fn(),
}));

vi.mock("@/lib/llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm")>("@/lib/llm");
  return {
    BudgetExceededError: actual.BudgetExceededError,
    suggestDashboards: mockSuggestDashboards,
  };
});

import { POST } from "../suggest/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validSuggestionsJson = JSON.stringify([
  {
    name: "Panel de Ventas Semanal",
    description: "Resumen semanal para el director de ventas",
    prompt: "Crea un dashboard de ventas semanales con ps_ventas y total_si...",
  },
  {
    name: "Análisis de Márgenes",
    description: "Márgenes por familia de producto",
    prompt: "Crea un dashboard de márgenes filtrando entrada=true...",
  },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/dashboard/suggest", () => {
  beforeEach(() => {
    mockSuggestDashboards.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when body is not JSON", async () => {
    const req = new Request("http://localhost/api/dashboard/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
  });

  it("returns 400 when role is missing", async () => {
    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
    expect(data.error).toContain("role");
  });

  it("returns 400 when role is empty string", async () => {
    const req = makeRequest({ role: "  ", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
  });

  it("returns 400 when existingDashboards is not an array", async () => {
    const req = makeRequest({ role: "Director de ventas", existingDashboards: "none" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
    expect(data.error).toContain("existingDashboards");
  });

  it("returns suggestions on valid request", async () => {
    mockSuggestDashboards.mockResolvedValue(validSuggestionsJson);

    const req = makeRequest({
      role: "Director de ventas",
      existingDashboards: [{ title: "Panel X", description: "Desc" }],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.suggestions).toHaveLength(2);
    expect(data.suggestions[0].name).toBe("Panel de Ventas Semanal");
    expect(data.suggestions[0].description).toBeTruthy();
    expect(data.suggestions[0].prompt).toBeTruthy();
  });

  it("works with empty existingDashboards array", async () => {
    mockSuggestDashboards.mockResolvedValue(validSuggestionsJson);

    const req = makeRequest({ role: "Comprador", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.suggestions)).toBe(true);
  });

  it("returns 400 when LLM returns invalid JSON", async () => {
    mockSuggestDashboards.mockResolvedValue("this is not json at all");

    const req = makeRequest({ role: "Responsable de stock", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns 400 when LLM returns non-array JSON", async () => {
    mockSuggestDashboards.mockResolvedValue('{"name": "not an array"}');

    const req = makeRequest({ role: "Comprador", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns 500 on LLM error", async () => {
    mockSuggestDashboards.mockRejectedValue(new Error("LLM connection failed"));

    const req = makeRequest({ role: "Director general", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.code).toBe("LLM_ERROR");
  });

  it("returns 429 on rate limit error", async () => {
    mockSuggestDashboards.mockRejectedValue(new Error("rate limit exceeded 429"));

    const req = makeRequest({ role: "Controller financiero", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe("LLM_RATE_LIMIT");
  });

  it("strips markdown fences from LLM JSON response", async () => {
    const withFences = `\`\`\`json\n${validSuggestionsJson}\n\`\`\``;
    mockSuggestDashboards.mockResolvedValue(withFences);

    const req = makeRequest({ role: "Director de ventas", existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.suggestions).toHaveLength(2);
  });

  it("returns requestId and timestamp in error responses", async () => {
    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    const data = await res.json();
    expect(data.requestId).toBeTruthy();
    expect(data.timestamp).toBeTruthy();
  });
});
