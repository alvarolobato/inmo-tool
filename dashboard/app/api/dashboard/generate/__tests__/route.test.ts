import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the LLM module ---
vi.mock("@/lib/llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm")>("@/lib/llm");
  return {
    ...actual,
    generateDashboard: vi.fn(),
  };
});

// --- Mock the schema module (pass-through by default) ---
vi.mock("@/lib/schema", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schema")>(
    "@/lib/schema",
  );
  return { ...actual };
});

// --- Mock the persistence module ---
vi.mock("@/lib/db-write", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db-write")>("@/lib/db-write");
  return {
    ...actual,
    // Dashboard INSERT (server-side save) + interaction link UPDATE.
    sql: vi.fn().mockResolvedValue([{ id: 42 }]),
    createInteraction: vi.fn().mockResolvedValue("mock-interaction-id"),
    appendInteractionLines: vi.fn().mockResolvedValue(undefined),
    finishInteraction: vi.fn().mockResolvedValue(undefined),
  };
});

// --- Mock the conversations module ---
vi.mock("@/lib/conversations", () => ({
  createConversation: vi.fn().mockResolvedValue({
    id: "mock-conv-id",
    c_url: "/c/mock-conv-id",
  }),
  appendMessage: vi.fn().mockResolvedValue(undefined),
  touchConversation: vi.fn().mockResolvedValue(undefined),
  migrateConversationToDashboard: vi.fn().mockResolvedValue({}),
}));

import { POST } from "../route";
import {
  generateDashboard,
  BudgetExceededError,
  CircuitBreakerOpenError,
} from "@/lib/llm";
import * as dbWrite from "@/lib/db-write";
import * as conversations from "@/lib/conversations";

const mockGenerate = vi.mocked(generateDashboard);
const mockCreateInteraction = vi.mocked(dbWrite.createInteraction);
const mockFinishInteraction = vi.mocked(dbWrite.finishInteraction);
const mockCreateConversation = vi.mocked(conversations.createConversation);
const mockTouchConversation = vi.mocked(conversations.touchConversation);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_SPEC = {
  title: "Ventas Marzo 2026",
  widgets: [
    {
      type: "kpi_row" as const,
      items: [
        {
          label: "Ventas Netas",
          sql: "SELECT SUM(total_si) FROM ps_ventas",
          format: "currency" as const,
          prefix: "€",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/dashboard/generate", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockCreateInteraction.mockReset();
    mockCreateInteraction.mockResolvedValue("mock-interaction-id");
    mockFinishInteraction.mockReset();
    mockFinishInteraction.mockResolvedValue(undefined);
    vi.mocked(dbWrite.appendInteractionLines).mockReset();
    vi.mocked(dbWrite.appendInteractionLines).mockResolvedValue(undefined);
    mockCreateConversation.mockReset();
    mockCreateConversation.mockResolvedValue({ id: "mock-conv-id", c_url: "/c/mock-conv-id" } as Awaited<ReturnType<typeof conversations.createConversation>>);
    mockTouchConversation.mockReset();
    mockTouchConversation.mockResolvedValue(undefined);
    vi.mocked(conversations.appendMessage).mockReset();
    vi.mocked(conversations.appendMessage).mockResolvedValue(undefined);
  });

  // --- Happy path ---

  it("returns a valid dashboard spec on success", async () => {
    mockGenerate.mockResolvedValue(JSON.stringify(VALID_SPEC));

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.title).toBe("Ventas Marzo 2026");
    expect(json.widgets).toHaveLength(1);
    expect(json.widgets[0].type).toBe("kpi_row");
  });

  it("returns NDJSON with meta, progress tail, and result when stream: true", async () => {
    mockGenerate.mockImplementation(async (_prompt, ctx) => {
      ctx?.onAgenticProgress?.({
        type: "round",
        round: 1,
        maxRounds: 8,
      });
      return JSON.stringify(VALID_SPEC);
    });

    const res = await POST(makeRequest({ prompt: "Ventas del mes", stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("ndjson");

    const text = await res.text();
    const lines = text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.some((o) => o.type === "meta")).toBe(true);
    expect(parsed.some((o) => o.type === "progress")).toBe(true);
    const resultLine = parsed.find((o) => o.type === "result");
    expect(resultLine?.spec).toBeDefined();
    expect((resultLine?.spec as { title?: string }).title).toBe("Ventas Marzo 2026");
  });

  it("strips markdown code fences from LLM response", async () => {
    const wrapped = "```json\n" + JSON.stringify(VALID_SPEC) + "\n```";
    mockGenerate.mockResolvedValue(wrapped);

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.title).toBe("Ventas Marzo 2026");
  });

  it("strips bare code fences (no json tag) from LLM response", async () => {
    const wrapped = "```\n" + JSON.stringify(VALID_SPEC) + "\n```";
    mockGenerate.mockResolvedValue(wrapped);

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    expect(res.status).toBe(200);
  });

  // --- Input validation ---

  it("returns 400 for empty prompt", async () => {
    const res = await POST(makeRequest({ prompt: "" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("vacío");
  });

  it("returns 400 for whitespace-only prompt", async () => {
    const res = await POST(makeRequest({ prompt: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing prompt field", async () => {
    const res = await POST(makeRequest({ query: "test" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("prompt");
  });

  it("returns 400 for non-string prompt", async () => {
    const res = await POST(makeRequest({ prompt: 123 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/dashboard/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("JSON no válido");
  });

  // --- LLM errors ---

  it("returns 429 with LLM_BUDGET_EXCEEDED when budget is exhausted", async () => {
    mockGenerate.mockRejectedValue(
      new BudgetExceededError("Límite diario de generación alcanzado. Reintente mañana."),
    );

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.code).toBe("LLM_BUDGET_EXCEEDED");
    expect(json.error).toContain("Límite diario");
  });

  it("returns 503 with LLM_CIRCUIT_OPEN when the LLM circuit is open", async () => {
    mockGenerate.mockRejectedValue(new CircuitBreakerOpenError());

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.code).toBe("LLM_CIRCUIT_OPEN");
    expect(json.error).toMatch(/no disponible|Inténtelo/i);
  });

  it("returns 500 when LLM throws a generic error", async () => {
    mockGenerate.mockRejectedValue(new Error("Connection timeout"));

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain("Inténtalo de nuevo");
  });

  it("returns 429 when LLM throws an error with status 429", async () => {
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), {
      status: 429,
    });
    mockGenerate.mockRejectedValue(rateLimitError);

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("Límite de uso");
  });

  it("returns 500 when LLM throws a non-Error value", async () => {
    mockGenerate.mockRejectedValue("unexpected string error");

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Inténtalo de nuevo");
  });

  // --- Invalid LLM output ---

  it("returns 400 when LLM returns non-JSON text", async () => {
    mockGenerate.mockResolvedValue(
      "I'm sorry, I cannot generate that dashboard.",
    );

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("LLM_INVALID_RESPONSE");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 when LLM returns JSON that fails schema validation", async () => {
    const invalidSpec = { title: "Test" }; // missing widgets
    mockGenerate.mockResolvedValue(JSON.stringify(invalidSpec));

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("LLM_INVALID_RESPONSE");
    expect(json.details).toBeDefined();
  });

  it("returns 400 when LLM returns JSON with invalid widget types", async () => {
    const badWidgets = {
      title: "Test",
      widgets: [{ type: "pie_chart", title: "Bad", sql: "SELECT 1" }],
    };
    mockGenerate.mockResolvedValue(JSON.stringify(badWidgets));

    const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 SQL_LINT when LLM returns EXTRACT(days FROM …) (PostgreSQL anti-pattern)", async () => {
    const badSqlSpec = {
      title: "Stock",
      description: "Test",
      glossary: [{ term: "a", definition: "b" }],
      widgets: [
        {
          id: "w1",
          type: "table",
          title: "T",
          sql: "SELECT EXTRACT(days FROM CURRENT_DATE - MAX(fecha_creacion)) AS dias FROM ps_ventas v GROUP BY v.reg_ventas",
        },
      ],
    };
    mockGenerate.mockResolvedValue(JSON.stringify(badSqlSpec));

    const res = await POST(makeRequest({ prompt: "stock lento" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("SQL_LINT");
    expect(String(json.details ?? "")).toMatch(/EXTRACT|PostgreSQL/i);
  });

  it("includes allowedFields for donut_chart when LLM uses category/value instead of x/y", async () => {
    const badSpec = {
      title: "T",
      widgets: [
        { type: "donut_chart", title: "T", sql: "S", category: "c", value: "v" },
      ],
    };
    mockGenerate.mockResolvedValue(JSON.stringify(badSpec));

    const res = await POST(makeRequest({ prompt: "dame un donut de ventas" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("LLM_INVALID_RESPONSE");
    expect(json.details).toBeDefined();
    expect(Array.isArray(json.allowedFields)).toBe(true);
    expect(json.allowedFields).toContain("x");
    expect(json.allowedFields).toContain("y");
  });

  // --- donut_chart smoke tests ---

  describe("donut_chart validation", () => {
    it("accepts a donut_chart spec with x/y fields", async () => {
      const mockSpec = {
        title: "Mix por Familia",
        widgets: [
          {
            id: "w1",
            type: "donut_chart",
            title: "Mix por Familia",
            sql: "SELECT fami AS category, SUM(total_si) AS value FROM ps_ventas GROUP BY 1",
            x: "category",
            y: "value",
          },
        ],
      };
      mockGenerate.mockResolvedValue(JSON.stringify(mockSpec));

      const res = await POST(makeRequest({ prompt: "dame un donut de ventas por familia" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.title).toBe("Mix por Familia");
      expect(json.widgets).toHaveLength(1);
      expect(json.widgets[0].type).toBe("donut_chart");
      expect(json.widgets[0].x).toBe("category");
      expect(json.widgets[0].y).toBe("value");
    });

    it("rejects a donut_chart spec with category/value fields (old buggy shape)", async () => {
      const badSpec = {
        title: "Mix por Familia",
        widgets: [
          {
            id: "w1",
            type: "donut_chart",
            title: "Mix por Familia",
            sql: "SELECT fami AS category, SUM(total_si) AS value FROM ps_ventas GROUP BY 1",
            category: "category",
            value: "value",
          },
        ],
      };
      mockGenerate.mockResolvedValue(JSON.stringify(badSpec));

      const res = await POST(makeRequest({ prompt: "dame un donut de ventas por familia" }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("LLM_INVALID_RESPONSE");
    });
  });

  // --- Persistence (createInteraction / finishInteraction) ---

  describe("interaction persistence (non-stream)", () => {
    it("creates an interaction and finishes it as completed on success", async () => {
      mockGenerate.mockResolvedValue(JSON.stringify(VALID_SPEC));

      const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
      expect(res.status).toBe(200);

      expect(mockCreateInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "generate", prompt: "Ventas del mes" }),
      );
      expect(mockFinishInteraction).toHaveBeenCalledWith(
        "mock-interaction-id",
        "completed",
        expect.any(String),
      );
    });

    it("creates an interaction and finishes it as error when LLM throws", async () => {
      mockGenerate.mockRejectedValue(new Error("LLM down"));

      const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
      expect(res.status).toBe(500);

      expect(mockCreateInteraction).toHaveBeenCalled();
      expect(mockFinishInteraction).toHaveBeenCalledWith(
        "mock-interaction-id",
        "error",
        expect.any(String),
      );
    });

    it("creates an interaction and finishes it as error when LLM returns invalid spec", async () => {
      mockGenerate.mockResolvedValue(JSON.stringify({ title: "no widgets" }));

      const res = await POST(makeRequest({ prompt: "Ventas del mes" }));
      expect(res.status).toBe(400);

      expect(mockCreateInteraction).toHaveBeenCalled();
      expect(mockFinishInteraction).toHaveBeenCalledWith(
        "mock-interaction-id",
        "error",
        expect.any(String),
      );
    });
  });

  // --- Conversation status (stream path) ---
  // Regression guard: the premature touchConversation(conv.id, "error") call
  // that was removed in fix #628 must not reappear. The conversation status
  // must stay NULL (in-progress) until the final success or failure handler.

  describe("conversation status (stream path)", () => {
    it("marks the conversation ok on success — never error", async () => {
      mockGenerate.mockResolvedValue(JSON.stringify(VALID_SPEC));

      const res = await POST(makeRequest({ prompt: "Ventas del mes", stream: true }));
      // Drain the stream so all async handlers complete.
      await res.text();

      expect(mockTouchConversation).toHaveBeenCalledWith("mock-conv-id", "ok");
      // Must never have been called with "error" — that would be the regression.
      const errorCalls = mockTouchConversation.mock.calls.filter((args) => args[1] === "error");
      expect(errorCalls).toHaveLength(0);
    });

    it("marks the conversation error on LLM failure — but not before generation runs", async () => {
      mockGenerate.mockRejectedValue(new Error("LLM failure"));

      const res = await POST(makeRequest({ prompt: "Ventas del mes", stream: true }));
      await res.text();

      // touchConversation("error") is correct here — it is the final handler.
      expect(mockTouchConversation).toHaveBeenCalledWith("mock-conv-id", "error");
      // Must have been called exactly once — no premature call before generation.
      expect(mockTouchConversation).toHaveBeenCalledTimes(1);
    });

    it("marks the conversation error on invalid spec — but not before generation runs", async () => {
      mockGenerate.mockResolvedValue(JSON.stringify({ title: "no widgets" }));

      const res = await POST(makeRequest({ prompt: "Ventas del mes", stream: true }));
      await res.text();

      expect(mockTouchConversation).toHaveBeenCalledWith("mock-conv-id", "error");
      // Exactly once — no premature call immediately after createConversation.
      expect(mockTouchConversation).toHaveBeenCalledTimes(1);
    });
  });
});
