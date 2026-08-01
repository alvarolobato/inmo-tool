// @vitest-environment jsdom
/**
 * Component tests for /admin/slow-queries page.
 * Covers: SQL formatting (task 2), sort (task 3), filter (task 4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AdminSlowQueriesPage from "../admin/slow-queries/page";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("prismjs", () => ({
  default: {
    highlight: (code: string) => code, // no-op for tests
    languages: { sql: {} },
  },
}));

vi.mock("prismjs/components/prism-sql", () => ({}));

// sql-formatter: use real implementation so we can test that formatted SQL
// has spaces around keywords.

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_QUERIES = [
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

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    json: async () => ({ queries: MOCK_QUERIES }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AdminSlowQueriesPage — render", () => {
  it("shows loading state before fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never resolves
    render(<AdminSlowQueriesPage />);
    expect(screen.getByText(/Cargando/i)).toBeInTheDocument();
  });

  it("renders three rows after fetch", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      expect(screen.getAllByRole("row").length).toBeGreaterThan(1); // header + data rows
    });
    // 3 data rows + 1 header
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(4);
  });

  it("displays error message when fetch returns error field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ queries: [], error: "pg_stat_statements not enabled" }),
    }));
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/pg_stat_statements not enabled/i)).toBeInTheDocument();
    });
  });
});

describe("AdminSlowQueriesPage — SQL formatting (task 2)", () => {
  it("formats fused keywords before display", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
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
      }),
    }));
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      // After formatting, SELECT and COUNT should appear separately
      const cells = screen.getAllByRole("cell");
      const sqlCell = cells[0];
      // The rendered text should not contain "SELECTCOUNT" fused together
      expect(sqlCell.textContent).not.toMatch(/SELECTCOUNT/);
    });
  });
});

describe("AdminSlowQueriesPage — sort (task 3)", () => {
  it("default sort is mean_exec_time_ms descending", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    // The sort arrow should appear on the "Media ms" sort button (active, descending)
    const buttons = screen.getAllByRole("button");
    const mediaBtn = buttons.find((b) => b.textContent?.includes("Media ms"));
    expect(mediaBtn).toBeDefined();
    // Active sort indicator: the arrow is ↓ for descending
    expect(mediaBtn!.textContent).toContain("↓");
  });

  it("clicking a column header sorts by that column descending", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const buttons = screen.getAllByRole("button");
    const llamadasBtn = buttons.find((b) => b.textContent?.includes("Llamadas"));
    expect(llamadasBtn).toBeDefined();

    act(() => {
      fireEvent.click(llamadasBtn!);
    });

    // After click, Llamadas button should show ↓ (now the active sort)
    await waitFor(() => {
      const updatedButtons = screen.getAllByRole("button");
      const updatedLlamadas = updatedButtons.find((b) => b.textContent?.includes("Llamadas"));
      expect(updatedLlamadas!.textContent).toContain("↓");
    });
  });

  it("clicking same column twice reverses direction", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const buttons = screen.getAllByRole("button");
    const mediaBtn = buttons.find((b) => b.textContent?.includes("Media ms"));

    // First click: already sorted desc, should flip to asc
    act(() => {
      fireEvent.click(mediaBtn!);
    });

    await waitFor(() => {
      const updatedButtons = screen.getAllByRole("button");
      const updatedMedia = updatedButtons.find((b) => b.textContent?.includes("Media ms"));
      expect(updatedMedia!.textContent).toContain("↑");
    });
  });

  it("rows are displayed in correct sort order (calls desc)", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const buttons = screen.getAllByRole("button");
    const llamadasBtn = buttons.find((b) => b.textContent?.includes("Llamadas"));

    act(() => {
      fireEvent.click(llamadasBtn!);
    });

    await waitFor(() => {
      // calls: [10, 5, 100] → sorted desc → [100, 10, 5]
      const rows = screen.getAllByRole("row").slice(1); // skip header
      const callValues = rows.map((row) => {
        const cells = row.querySelectorAll("td");
        return cells[1]?.textContent ?? "";
      });
      // 100 should come first, then 10, then 5
      const nums = callValues.map((v) => parseInt(v.replace(/\./g, "").replace(/,/g, ""), 10));
      expect(nums[0]).toBeGreaterThan(nums[1]);
      expect(nums[1]).toBeGreaterThan(nums[2]);
    });
  });
});

describe("AdminSlowQueriesPage — filter (task 4)", () => {
  it("filter input is rendered", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);
    const filterInput = screen.getByPlaceholderText(/Filtrar/i);
    expect(filterInput).toBeInTheDocument();
  });

  it("typing in filter narrows rows", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    // Filter to only queries mentioning ps_stock_tienda
    act(() => {
      fireEvent.change(filterInput, { target: { value: "ps_stock_tienda" } });
    });

    // Wait for debounce
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      // Should have only 1 row (the stock query)
      expect(rows.length).toBe(1);
    });
  });

  it("filter is case-insensitive", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    act(() => {
      fireEvent.change(filterInput, { target: { value: "PS_STOCK_TIENDA" } });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.length).toBe(1);
    });
  });

  it("shows '0 de N consultas' indicator when filter has no matches", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getAllByRole("row").length > 1);

    const filterInput = screen.getByPlaceholderText(/Filtrar/i);

    act(() => {
      fireEvent.change(filterInput, { target: { value: "zzznomatch" } });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(() => {
      expect(screen.getByText(/0 de 3 consultas/i)).toBeInTheDocument();
    });
  });

  it("shows total count when no filter is active", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/3 consultas/i)).toBeInTheDocument();
    });
  });
});

describe("AdminSlowQueriesPage — origin (task 5)", () => {
  it("shows origin badge when query has an origin", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Posible origen/i)).toBeInTheDocument();
      expect(screen.getByText(/Responsable de Ventas/)).toBeInTheDocument();
    });
  });

  it("shows location hint as a code element", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      const codeEl = screen.getByText("dashboard/lib/templates/ventas.ts");
      expect(codeEl.tagName.toLowerCase()).toBe("code");
    });
  });
});

describe("AdminSlowQueriesPage — guidance panel (task 6)", () => {
  it("renders the guidance panel toggle button", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Cómo actuar/i)).toBeInTheDocument();
    });
  });

  it("guidance panel is collapsed by default", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => {
      // The guidance content should not be visible initially
      expect(screen.queryByText(/Mide primero/i)).not.toBeInTheDocument();
    });
  });

  it("clicking toggle opens the guidance panel", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getByText(/Cómo actuar/i));

    act(() => {
      fireEvent.click(screen.getByText(/Cómo actuar/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Mide primero/i)).toBeInTheDocument();
      expect(screen.getByText(/etl\/schema\/init\.sql/i)).toBeInTheDocument();
    });
  });

  it("clicking toggle again closes the guidance panel", async () => {
    render(<AdminSlowQueriesPage />);
    await waitFor(() => screen.getByText(/Cómo actuar/i));

    const toggle = screen.getByText(/Cómo actuar/i);

    act(() => { fireEvent.click(toggle); });
    await waitFor(() => screen.getByText(/Mide primero/i));

    act(() => { fireEvent.click(toggle); });
    await waitFor(() => {
      expect(screen.queryByText(/Mide primero/i)).not.toBeInTheDocument();
    });
  });
});
