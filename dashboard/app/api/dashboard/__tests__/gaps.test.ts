import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures the mock variable is available before vi.mock hoisting
const { mockAnalyzeGaps } = vi.hoisted(() => ({
  mockAnalyzeGaps: vi.fn(),
}));

vi.mock("@/lib/llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm")>("@/lib/llm");
  return {
    BudgetExceededError: actual.BudgetExceededError,
    analyzeGaps: mockAnalyzeGaps,
  };
});

import { POST } from "../gaps/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/gaps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validGapsJson = JSON.stringify([
  {
    area: "Análisis de Márgenes",
    description: "No tienes un panel que muestre la evolución de márgenes por familia.",
    suggestedPrompt:
      "Crea un dashboard de márgenes con ps_lineas_ventas y ps_articulos usando total_si...",
  },
  {
    area: "Gestión de Compras",
    description: "Las compras y pedidos a proveedores no están representados.",
    suggestedPrompt:
      "Crea un dashboard de compras con ps_compras, incluyendo estado de pedidos...",
  },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/dashboard/gaps", () => {
  beforeEach(() => {
    mockAnalyzeGaps.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when body is not JSON", async () => {
    const req = new Request("http://localhost/api/dashboard/gaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
  });

  it("returns 400 when existingDashboards is missing", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
    expect(data.error).toContain("existingDashboards");
  });

  it("returns 400 when existingDashboards is not an array", async () => {
    const req = makeRequest({ existingDashboards: "not-array" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("VALIDATION");
  });

  it("accepts empty existingDashboards array", async () => {
    mockAnalyzeGaps.mockResolvedValue(validGapsJson);

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns gaps on valid request with dashboards", async () => {
    mockAnalyzeGaps.mockResolvedValue(validGapsJson);

    const req = makeRequest({
      existingDashboards: [
        {
          title: "Panel de Ventas",
          description: "Ventas mensuales",
          widgetTitles: ["Ventas Netas", "Ticket Medio"],
        },
      ],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.gaps).toHaveLength(2);
    expect(data.gaps[0].area).toBe("Análisis de Márgenes");
    expect(data.gaps[0].description).toBeTruthy();
    expect(data.gaps[0].suggestedPrompt).toBeTruthy();
  });

  it("passes widget titles to analyzeGaps", async () => {
    mockAnalyzeGaps.mockResolvedValue(validGapsJson);

    const dashboards = [
      {
        title: "Panel X",
        description: "Test",
        widgetTitles: ["Widget A", "Widget B"],
      },
    ];
    const req = makeRequest({ existingDashboards: dashboards });
    await POST(req);

    expect(mockAnalyzeGaps).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Panel X",
          widgetTitles: ["Widget A", "Widget B"],
        }),
      ]),
      expect.objectContaining({ requestId: expect.stringMatching(/^req_/) }),
    );
  });

  it("returns 400 when LLM returns invalid JSON", async () => {
    mockAnalyzeGaps.mockResolvedValue("this is not json");

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns 400 when LLM returns non-array JSON", async () => {
    mockAnalyzeGaps.mockResolvedValue('{"area": "not an array"}');

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("LLM_INVALID_RESPONSE");
  });

  it("returns 500 on LLM error", async () => {
    mockAnalyzeGaps.mockRejectedValue(new Error("LLM connection failed"));

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.code).toBe("LLM_ERROR");
  });

  it("returns 429 on rate limit error", async () => {
    mockAnalyzeGaps.mockRejectedValue(new Error("ratelimit 429 exceeded"));

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe("LLM_RATE_LIMIT");
  });

  it("strips markdown fences from LLM JSON response", async () => {
    const withFences = `\`\`\`json\n${validGapsJson}\n\`\`\``;
    mockAnalyzeGaps.mockResolvedValue(withFences);

    const req = makeRequest({ existingDashboards: [] });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.gaps).toHaveLength(2);
  });

  it("returns requestId and timestamp in error responses", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    const data = await res.json();
    expect(data.requestId).toBeTruthy();
    expect(data.timestamp).toBeTruthy();
  });

  it("handles dashboards with no widget titles gracefully", async () => {
    mockAnalyzeGaps.mockResolvedValue(validGapsJson);

    const req = makeRequest({
      existingDashboards: [
        { title: "Panel sin widgets", description: "Desc", widgetTitles: [] },
      ],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
