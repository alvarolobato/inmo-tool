// @vitest-environment jsdom
/**
 * Component tests for SlowQueriesPanel (formerly the standalone
 * /admin/slow-queries page, deleted in #653 — this behavior moved to a
 * collapsed disclosure on /admin/llm and the data prop replaced the client
 * fetch, since `fetchSlowQueries()` now runs once, server-side, in the page).
 *
 * Covers: the outer disclosure toggle, SQL formatting (task 2), sort
 * (task 3), filter (task 4), origin badges (task 5), the nested guidance
 * panel (task 6) — same behaviors the old page tested, now driven by a
 * `data` prop instead of a mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SlowQueriesPanel, type SlowQueriesData } from "../SlowQueriesPanel";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("prismjs", () => ({
  default: {
    highlight: (code: string) => code, // no-op for tests
    languages: { sql: {} },
  },
}));

vi.mock("prismjs/components/prism-sql", () => ({}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_QUERIES: SlowQueriesData["queries"] = [
  {
    query: "SELECT COUNT(*) AS cnt FROM ps_ventas WHERE entrada = $1",
    calls: 10,
    mean_exec_time_ms: 500,
    max_exec_time_ms: 800,
    total_exec_time_ms: 5000,
    rows: 1,
    cache_hit_ratio: 99.5,
    origin: { source: "Template: Responsable de Ventas", locationHint: "dashboard/lib/templates/ventas.ts" },
  },
  {
    query: "SELECT tienda, SUM(stock) AS total FROM ps_stock_tienda GROUP BY tienda ORDER BY total DESC",
    calls: 5,
    mean_exec_time_ms: 2500,
    max_exec_time_ms: 3000,
    total_exec_time_ms: 12500,
    rows: 50,
    cache_hit_ratio: 85.2,
  },
  {
    query: "SELECT lv.codigo, SUM(lv.unidades) AS u FROM ps_lineas_ventas lv WHERE lv.tienda = $1 GROUP BY lv.codigo",
    calls: 100,
    mean_exec_time_ms: 120,
    max_exec_time_ms: 300,
    total_exec_time_ms: 12000,
    rows: 500,
    cache_hit_ratio: null,
  },
];

/** Render the panel already opened (click past the outer disclosure toggle). */
function renderOpen(data: SlowQueriesData) {
  render(<SlowQueriesPanel data={data} />);
  act(() => {
    fireEvent.click(screen.getByTestId("slow-queries-disclosure-toggle"));
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SlowQueriesPanel — outer disclosure", () => {
  it("is collapsed by default (table not rendered)", () => {
    render(<SlowQueriesPanel data={{ queries: MOCK_QUERIES }} />);
    expect(screen.queryAllByRole("row").length).toBe(0);
    expect(screen.getByTestId("slow-queries-disclosure-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the total count on the collapsed toggle", () => {
    render(<SlowQueriesPanel data={{ queries: MOCK_QUERIES }} />);
    expect(screen.getByText("3 consultas")).toBeInTheDocument();
  });

  it("clicking the toggle reveals the table", () => {
    renderOpen({ queries: MOCK_QUERIES });
    // 3 data rows + 1 header
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(4);
  });

  it("displays the error message when data carries an error field", () => {
    renderOpen({ queries: [], error: "pg_stat_statements not enabled" });
    expect(screen.getByText(/pg_stat_statements not enabled/i)).toBeInTheDocument();
  });
});

describe("SlowQueriesPanel — SQL formatting (task 2)", () => {
  it("formats fused keywords before display", () => {
    renderOpen({
      queries: [
        {
          query: "SELECTCOUNT(*)AS cnt FROM ps_ventas",
          calls: 1,
          mean_exec_time_ms: 10,
          max_exec_time_ms: 20,
          total_exec_time_ms: 10,
          rows: 1,
          cache_hit_ratio: 90,
        },
      ],
    });
    const cells = screen.getAllByRole("cell");
    const sqlCell = cells[0];
    // The rendered text should not contain "SELECTCOUNT" fused together
    expect(sqlCell.textContent).not.toMatch(/SELECTCOUNT/);
  });
});

describe("SlowQueriesPanel — sort (task 3)", () => {
  it("default sort is mean_exec_time_ms descending", () => {
    renderOpen({ queries: MOCK_QUERIES });
    const buttons = screen.getAllByRole("button");
    const mediaBtn = buttons.find((b) => b.textContent?.includes("Media ms"));
    expect(mediaBtn).toBeDefined();
    expect(mediaBtn!.textContent).toContain("↓");
  });

  it("clicking a column header sorts by that column descending", () => {
    renderOpen({ queries: MOCK_QUERIES });
    const buttons = screen.getAllByRole("button");
    const llamadasBtn = buttons.find((b) => b.textContent?.includes("Llamadas"));
    expect(llamadasBtn).toBeDefined();

    act(() => {
      fireEvent.click(llamadasBtn!);
    });

    const updatedButtons = screen.getAllByRole("button");
    const updatedLlamadas = updatedButtons.find((b) => b.textContent?.includes("Llamadas"));
    expect(updatedLlamadas!.textContent).toContain("↓");
  });

  it("clicking same column twice reverses direction", () => {
    renderOpen({ queries: MOCK_QUERIES });
    const buttons = screen.getAllByRole("button");
    const mediaBtn = buttons.find((b) => b.textContent?.includes("Media ms"));

    act(() => {
      fireEvent.click(mediaBtn!);
    });

    const updatedButtons = screen.getAllByRole("button");
    const updatedMedia = updatedButtons.find((b) => b.textContent?.includes("Media ms"));
    expect(updatedMedia!.textContent).toContain("↑");
  });

  it("rows are displayed in correct sort order (calls desc)", () => {
    renderOpen({ queries: MOCK_QUERIES });
    const buttons = screen.getAllByRole("button");
    const llamadasBtn = buttons.find((b) => b.textContent?.includes("Llamadas"));

    act(() => {
      fireEvent.click(llamadasBtn!);
    });

    // calls: [10, 5, 100] → sorted desc → [100, 10, 5]
    const rows = screen.getAllByRole("row").slice(1); // skip header
    const callValues = rows.map((row) => {
      const cells = row.querySelectorAll("td");
      return cells[1]?.textContent ?? "";
    });
    const nums = callValues.map((v) => parseInt(v.replace(/\./g, "").replace(/,/g, ""), 10));
    expect(nums[0]).toBeGreaterThan(nums[1]);
    expect(nums[1]).toBeGreaterThan(nums[2]);
  });
});

describe("SlowQueriesPanel — filter (task 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filter input is rendered", () => {
    renderOpen({ queries: MOCK_QUERIES });
    expect(screen.getByPlaceholderText(/Filtrar/i)).toBeInTheDocument();
  });

  it("typing in filter narrows rows", async () => {
    renderOpen({ queries: MOCK_QUERIES });
    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    act(() => {
      fireEvent.change(filterInput, { target: { value: "ps_stock_tienda" } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
    });
  });

  it("filter is case-insensitive", async () => {
    renderOpen({ queries: MOCK_QUERIES });
    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    act(() => {
      fireEvent.change(filterInput, { target: { value: "PS_STOCK_TIENDA" } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
    });
  });

  it("shows '0 de N consultas' indicator when filter has no matches", async () => {
    renderOpen({ queries: MOCK_QUERIES });
    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    act(() => {
      fireEvent.change(filterInput, { target: { value: "zzznomatch" } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    await waitFor(() => {
      expect(screen.getByText(/0 de 3 consultas/i)).toBeInTheDocument();
    });
  });

  it("shows total count when no filter is active", () => {
    renderOpen({ queries: MOCK_QUERIES });
    // Two "3 consultas" occurrences now: the collapsed-toggle summary and the
    // filter-row count — both present once the panel is open.
    expect(screen.getAllByText(/3 consultas/i).length).toBeGreaterThan(0);
  });
});

describe("SlowQueriesPanel — origin (task 5)", () => {
  it("shows origin badge when a query has an origin", () => {
    renderOpen({ queries: MOCK_QUERIES });
    expect(screen.getByText(/Posible origen/i)).toBeInTheDocument();
    expect(screen.getByText(/Responsable de Ventas/)).toBeInTheDocument();
  });

  it("shows location hint as a code element", () => {
    renderOpen({ queries: MOCK_QUERIES });
    const codeEl = screen.getByText("dashboard/lib/templates/ventas.ts");
    expect(codeEl.tagName.toLowerCase()).toBe("code");
  });
});

describe("SlowQueriesPanel — nested guidance panel (task 6)", () => {
  it("renders the guidance panel toggle button", () => {
    renderOpen({ queries: MOCK_QUERIES });
    expect(screen.getByText(/Cómo actuar/i)).toBeInTheDocument();
  });

  it("guidance panel is collapsed by default", () => {
    renderOpen({ queries: MOCK_QUERIES });
    expect(screen.queryByText(/Mide primero/i)).not.toBeInTheDocument();
  });

  it("clicking toggle opens the guidance panel", async () => {
    renderOpen({ queries: MOCK_QUERIES });

    act(() => {
      fireEvent.click(screen.getByText(/Cómo actuar/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Mide primero/i)).toBeInTheDocument();
      expect(screen.getByText(/etl\/schema\/init\.sql/i)).toBeInTheDocument();
    });
  });

  it("clicking toggle again closes the guidance panel", async () => {
    renderOpen({ queries: MOCK_QUERIES });
    const toggle = screen.getByText(/Cómo actuar/i);

    act(() => {
      fireEvent.click(toggle);
    });
    await waitFor(() => screen.getByText(/Mide primero/i));

    act(() => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Mide primero/i)).not.toBeInTheDocument();
    });
  });
});
