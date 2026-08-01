// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ReviewPage from "../review/page";
import type { ReviewContent } from "@/lib/review-schema";

// ─── Mock next/navigation ─────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

// ─── Shared v2 review content ─────────────────────────────────────────────────

const reviewContentV2: ReviewContent = {
  review_schema_version: 2,
  executive_summary: [
    "Ventas semanales 45.230€, +12% vs semana anterior",
    "Tienda 03 lidera con 8.200€",
    "Stock crítico en 8 referencias",
  ],
  sections: [
    {
      key: "ventas_retail",
      title: "Ventas Retail",
      narrative: "Las ventas retail alcanzaron 45.230€ esta semana.",
      kpis: ["Ventas netas +12%"],
      evidence_queries: ["ventas_semana_cerrada"],
      dashboard_key: "ventas_retail",
    },
    {
      key: "canal_mayorista",
      title: "Canal Mayorista",
      narrative: "La facturación mayorista asciende a 23.500€.",
      kpis: ["Facturación B2B"],
      evidence_queries: ["facturacion_mayorista_semana_cerrada"],
      dashboard_key: "canal_mayorista",
    },
    {
      key: "stock",
      title: "Stock y Logística",
      narrative: "Stock total de 12.450 unidades.",
      kpis: ["Stock total"],
      evidence_queries: ["stock_total_unidades"],
      dashboard_key: "stock",
    },
    {
      key: "compras",
      title: "Compras",
      narrative: "3 pedidos de compra esta semana.",
      kpis: ["3 pedidos"],
      evidence_queries: ["compras_semana_cerrada"],
      dashboard_key: "compras",
    },
  ],
  action_items: [
    {
      action_key: "revisar_stock_critico",
      priority: "alta",
      owner_role: "Logística",
      owner_name: "",
      due_date: "2026-04-10",
      action: "Revisar stock crítico de 8 referencias",
      expected_impact: "Menos roturas",
      evidence_queries: ["articulos_stock_critico"],
      dashboard_key: "stock",
    },
    {
      action_key: "contactar_mayoristas",
      priority: "media",
      owner_role: "Ventas B2B",
      owner_name: "",
      due_date: "2026-04-11",
      action: "Contactar con los 3 clientes mayoristas pendientes de factura",
      expected_impact: "Mejor cobro",
      evidence_queries: ["top3_clientes_mayorista_semana_cerrada"],
      dashboard_key: "canal_mayorista",
    },
    {
      action_key: "planificar_traspasos",
      priority: "baja",
      owner_role: "Tiendas",
      owner_name: "",
      due_date: "2026-04-12",
      action: "Planificar traspasos entre tiendas para optimizar el stock",
      expected_impact: "Mejor distribución",
      evidence_queries: ["traspasos_semana_cerrada"],
      dashboard_key: "stock",
    },
  ],
  data_quality_notes: [],
  generated_at: "2026-04-05T10:00:00.000Z",
  quality_status: "ok",
};

const mockPastReviewSummaries = [
  {
    week_start: "2026-03-31",
    latest_id: 1,
    latest_revision: 1,
    revision_count: 1,
    executive_summary: reviewContentV2.executive_summary.join(" · "),
    created_at: "2026-04-05T10:00:00.000Z",
  },
  {
    week_start: "2026-03-24",
    latest_id: 2,
    latest_revision: 1,
    revision_count: 1,
    executive_summary: "Ventas 40.000€ · Sin alertas de stock",
    created_at: "2026-03-29T09:00:00.000Z",
  },
];

const revisionRowForWeek = {
  id: 1,
  week_start: "2026-03-31",
  revision: 1,
  generation_mode: "initial",
  created_at: "2026-04-05T10:00:00.000Z",
  preview: reviewContentV2.executive_summary[0],
};

const fullReviewApiPayload = {
  id: 1,
  week_start: "2026-03-31",
  revision: 1,
  generation_mode: "initial",
  content: reviewContentV2,
  actions: [] as const,
};

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : String(input);
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return raw;
  }
}

function jsonResponse(ok: boolean, data: unknown, status?: number) {
  return Promise.resolve({
    ok,
    status: status ?? (ok ? 200 : 500),
    json: () => Promise.resolve(data),
    headers: { get: () => "application/json" },
  });
}

/**
 * Build a mock Response that returns NDJSON stream with the given frames.
 * This simulates the streaming review/generate endpoint.
 */
function ndjsonStreamResponse(frames: unknown[], status = 200) {
  const encoder = new TextEncoder();
  const lines = frames.map((f) => JSON.stringify(f) + "\n").join("");
  const bytes = encoder.encode(lines);
  let consumed = false;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name === "content-type" ? "application/x-ndjson" : null },
    body: {
      getReader() {
        return {
          read: async () => {
            if (!consumed) {
              consumed = true;
              return { done: false, value: bytes };
            }
            return { done: true, value: undefined };
          },
          releaseLock: () => {},
        };
      },
    },
    json: () => Promise.resolve(frames[frames.length - 1]),
  });
}

const generateSuccessFrames = [
  { type: "meta", requestId: "req_test", message: "Generación de revisión iniciada", weekStart: "2026-03-31", generationMode: "initial" },
  { type: "phase", message: "Ejecutando consultas SQL" },
  { type: "result", review: {
    ...reviewContentV2,
    id: 1,
    week_start: "2026-03-31",
    revision: 1,
    generation_mode: "initial",
  }},
];

function installGenerateSuccessFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "POST" && path === "/api/review/generate") {
      return ndjsonStreamResponse(generateSuccessFrames);
    }
    if (path.startsWith("/api/review/week/")) {
      return jsonResponse(true, [revisionRowForWeek]);
    }
    if (/^\/api\/review\/\d+$/.test(path)) {
      return jsonResponse(true, fullReviewApiPayload);
    }
    if (path === "/api/review") {
      return jsonResponse(true, []);
    }
    return jsonResponse(false, { error: "unexpected fetch " + path }, 404);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ ok: boolean; data: unknown }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({
      ok: response.ok,
      status: response.ok ? 200 : 500,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(response.data),
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders the page title", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ReviewPage />);
    expect(screen.getByText("Revisión Semanal")).toBeInTheDocument();
  });

  it("renders the 'Generar revisión semanal' button", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ReviewPage />);
    expect(screen.getByTestId("generate-button")).toBeInTheDocument();
    expect(screen.getByText("Generar revisión semanal")).toBeInTheDocument();
  });

  // ─── Issue #412 item 14 — accent button (no bg-blue) ────────────────────────
  // The "Generar revisión semanal" CTA must use the shared .btn-accent helper
  // so it picks up the design tokens (var(--accent) + brightness hover) instead
  // of the legacy bg-blue-500 Tailwind classes.
  it("the 'Generar revisión semanal' button uses .btn-accent (no bg-blue tailwind)", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ReviewPage />);
    const btn = screen.getByTestId("generate-button");
    expect(btn.className).toContain("btn-accent");
    expect(btn.className).not.toMatch(/bg-blue-/);
  });

  it("shows loading spinner while fetching past reviews", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<ReviewPage />);
    expect(screen.getByLabelText("Cargando revisiones")).toBeInTheDocument();
  });

  it("renders past reviews list after loading", async () => {
    globalThis.fetch = mockFetch([{ ok: true, data: mockPastReviewSummaries }]);
    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/Semana del/).length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByTestId("past-review-1")).toBeInTheDocument();
    expect(screen.getByTestId("past-review-2")).toBeInTheDocument();
  });

  it("shows empty state when no past reviews", async () => {
    globalThis.fetch = mockFetch([{ ok: true, data: [] }]);
    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });
  });

  it("shows error state when list fetch fails", async () => {
    globalThis.fetch = mockFetch([{ ok: false, data: { error: "Server error" } }]);
    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows loading skeleton when generate is clicked", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/api/review/generate") {
        return new Promise(() => {});
      }
      return jsonResponse(true, []);
    });

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/Generando revisión/)).toBeInTheDocument();
  });

  it("renders the review after successful generation", async () => {
    installGenerateSuccessFetch();

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    await waitFor(() => {
      expect(screen.getByText("Resumen Ejecutivo")).toBeInTheDocument();
    });
    expect(screen.getByText("Ventas Retail")).toBeInTheDocument();
    expect(screen.getByText("Canal Mayorista")).toBeInTheDocument();
  });

  it("shows error when generation fails", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve([]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        json: () =>
          Promise.resolve({
            error: "No se pudo conectar a la base de datos.",
            code: "DB_CONNECTION",
            timestamp: new Date().toISOString(),
            requestId: "req_test123",
          }),
      });

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/No se pudo conectar/)).toBeInTheDocument();
  });

  it("loads a past review when clicking on it", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return jsonResponse(false, {}, 400);
      }
      if (path.startsWith("/api/review/week/")) {
        return jsonResponse(true, [revisionRowForWeek]);
      }
      if (/^\/api\/review\/\d+$/.test(path)) {
        return jsonResponse(true, fullReviewApiPayload);
      }
      if (path === "/api/review") {
        return jsonResponse(true, mockPastReviewSummaries);
      }
      return jsonResponse(false, { error: "unexpected" }, 404);
    });

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId("past-review-1")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("past-review-1"));
    });

    await waitFor(() => {
      expect(screen.getByText("Resumen Ejecutivo")).toBeInTheDocument();
    });
  });

  it("shows 'Volver a la lista' button when viewing a review", async () => {
    installGenerateSuccessFetch();

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Volver a la lista/)).toBeInTheDocument();
    });
  });

  it("returns to list when 'Volver a la lista' is clicked", async () => {
    installGenerateSuccessFetch();

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Volver a la lista/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/Volver a la lista/));
    });

    expect(screen.getByTestId("generate-button")).toBeInTheDocument();
  });

  // ─── Regenerate dropdown wording (issue #399) ─────────────────────────────
  // The "Ángulo alternativo" label was ambiguous. Rename to
  // "Reformular análisis (nuevo enfoque)" while preserving the legacy
  // `alternate_angle` value so the API/DB schema stays stable.

  it("regenerate dropdown shows the new label while keeping the legacy value", async () => {
    installGenerateSuccessFetch();

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    const select = await screen.findByTestId("regen-mode-select");
    const options = Array.from(select.querySelectorAll("option"));
    const altOption = options.find((o) => o.value === "alternate_angle");
    expect(altOption).toBeDefined();
    expect(altOption?.textContent).toMatch(/Reformular análisis/);
    // Make sure the old ambiguous label is gone.
    expect(altOption?.textContent).not.toMatch(/Ángulo alternativo/);
    // Tooltip explains what the mode does.
    expect(altOption?.getAttribute("title")).toMatch(/mismos datos/i);

    // The "Actualizar datos" option must survive the rename.
    const refreshOption = options.find((o) => o.value === "refresh_data");
    expect(refreshOption?.textContent).toMatch(/Actualizar datos/);
  });

  // ─── Accessible regenerate hint ───────────────────────────────────────────
  // Native `<option title>` tooltips are not reliably announced by screen
  // readers and not available on touch. Expose the meaning of the options via
  // a visible hint that is wired to the <select> with aria-describedby, plus
  // an accessible name on the select itself.

  it("regenerate select exposes an accessible name + describedby hint", async () => {
    installGenerateSuccessFetch();

    render(<ReviewPage />);

    await waitFor(() => {
      expect(screen.getByText("No hay revisiones anteriores")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-button"));
    });

    const select = await screen.findByTestId("regen-mode-select");
    // Accessible name must not rely solely on the native title attribute.
    expect(select.getAttribute("aria-label")).toBeTruthy();
    // aria-describedby must point at an existing element with a useful hint.
    const describedById = select.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const hint = document.getElementById(describedById!);
    expect(hint).not.toBeNull();
    expect(hint?.textContent ?? "").toMatch(/Elige cómo regenerar/);

    // Hint updates with the selected mode so screen readers + touch users
    // understand what each mode does without relying on option tooltips.
    await act(async () => {
      fireEvent.change(select, { target: { value: "alternate_angle" } });
    });
    expect(screen.getByTestId("regen-mode-hint").textContent ?? "").toMatch(
      /Reformular análisis/,
    );

    await act(async () => {
      fireEvent.change(select, { target: { value: "refresh_data" } });
    });
    expect(screen.getByTestId("regen-mode-hint").textContent ?? "").toMatch(
      /Actualizar datos/,
    );
  });
});
