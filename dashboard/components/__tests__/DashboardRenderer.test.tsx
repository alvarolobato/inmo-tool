// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "../widgets/__tests__/setup";
import { DashboardRenderer } from "../DashboardRenderer";
import type { DashboardSpec } from "@/lib/schema";
import type { DateRange, ComparisonRange } from "../DateRangePicker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchSuccess(data: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const barSpec: DashboardSpec = {
  title: "Panel de Ventas",
  description: "Resumen mensual de ventas",
  widgets: [
    {
      id: "w1",
      type: "bar_chart",
      title: "Ventas por Tienda",
      sql: "SELECT tienda, total FROM ps_ventas",
      x: "tienda",
      y: "total",
    },
  ],
};

const kpiSpec: DashboardSpec = {
  title: "KPIs",
  widgets: [
    {
      type: "kpi_row",
      items: [
        {
          label: "Ventas Netas",
          sql: "SELECT SUM(total_si) FROM ps_ventas",
          format: "currency",
          prefix: "\u20ac",
        },
        {
          label: "Tickets",
          sql: "SELECT COUNT(*) FROM ps_ventas",
          format: "number",
        },
      ],
    },
  ],
};

const multiWidgetSpec: DashboardSpec = {
  title: "Dashboard Completo",
  description: "Todos los tipos",
  widgets: [
    {
      type: "kpi_row",
      items: [
        {
          label: "Total",
          sql: "SELECT 1",
          format: "number",
        },
      ],
    },
    {
      type: "bar_chart",
      title: "Barras",
      sql: "SELECT x, y FROM t",
      x: "x",
      y: "y",
    },
    {
      type: "line_chart",
      title: "Lineas",
      sql: "SELECT x, y FROM t",
      x: "x",
      y: "y",
    },
    {
      type: "area_chart",
      title: "Area",
      sql: "SELECT x, y FROM t",
      x: "x",
      y: "y",
    },
    {
      type: "donut_chart",
      title: "Donut",
      sql: "SELECT x, y FROM t",
      x: "x",
      y: "y",
    },
    {
      type: "table",
      title: "Tabla",
      sql: "SELECT a FROM t",
    },
    {
      type: "number",
      title: "Numero",
      sql: "SELECT 42",
      format: "number",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DashboardRenderer", () => {
  it("renders widgets without duplicating spec title in body", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["tienda", "total"],
      rows: [["Madrid", 100]],
    }));

    render(<DashboardRenderer spec={barSpec} />);

    // spec.title is rendered by the page shell (not DashboardRenderer) — should not appear here
    expect(screen.queryByText("Panel de Ventas")).not.toBeInTheDocument();
    expect(screen.queryByText("Resumen mensual de ventas")).not.toBeInTheDocument();
    // Widget title should still appear
    await waitFor(() => {
      expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
    });
  });

  it("renders widgets without spec header when description is omitted", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["value"],
      rows: [[42]],
    }));

    render(<DashboardRenderer spec={kpiSpec} />);

    // spec.title not in DashboardRenderer body
    expect(screen.queryByText("KPIs")).not.toBeInTheDocument();
  });

  it("shows loading skeleton initially", () => {
    // Make fetch hang indefinitely so we stay in loading state
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<DashboardRenderer spec={barSpec} />);

    expect(screen.getByTestId("widget-skeleton")).toBeInTheDocument();
  });

  it("renders correct widget component for bar_chart", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["tienda", "total"],
      rows: [["Madrid", 100]],
    }));

    render(<DashboardRenderer spec={barSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
    });
  });

  it("renders kpi_row with parallel fetches per item", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            columns: ["value"],
            rows: [[callCount === 1 ? 5000 : 123]],
          }),
      } as unknown as Response);
    }));

    render(<DashboardRenderer spec={kpiSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Ventas Netas")).toBeInTheDocument();
      expect(screen.getByText("Tickets")).toBeInTheDocument();
    });

    // Should have called fetch for each KPI item
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows error message on query failure without breaking other widgets", async () => {
    // First call fails, second succeeds
    let callIdx = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "Query timeout" }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            columns: ["x", "y"],
            rows: [["A", 1]],
          }),
      } as unknown as Response);
    }));

    const twoWidgetSpec: DashboardSpec = {
      title: "Mixed",
      widgets: [
        {
          type: "number",
          title: "Broken",
          sql: "SELECT fail",
          format: "number",
        },
        {
          type: "bar_chart",
          title: "Working",
          sql: "SELECT x, y FROM t",
          x: "x",
          y: "y",
        },
      ],
    };

    render(<DashboardRenderer spec={twoWidgetSpec} />);

    await waitFor(() => {
      // Error widget shows error message via ErrorDisplay
      expect(screen.getByText("Query timeout")).toBeInTheDocument();
      // Working widget still renders
      expect(screen.getByText("Working")).toBeInTheDocument();
    });
  });

  it("handles empty widgets array", () => {
    const emptySpec: DashboardSpec = {
      title: "Vacio",
      widgets: [
        {
          type: "number",
          title: "placeholder",
          sql: "SELECT 1",
          format: "number",
        },
      ],
    };
    // Override to truly empty - bypass zod min(1) for test purposes
    const hackedSpec = { ...emptySpec, widgets: [] } as unknown as DashboardSpec;

    // Should not call fetch at all
    vi.stubGlobal("fetch", vi.fn());

    render(<DashboardRenderer spec={hackedSpec} />);

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("widget-skeleton")).not.toBeInTheDocument();
  });

  it("renders all widget types correctly", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["x", "y"],
      rows: [["A", 42]],
    }));

    render(<DashboardRenderer spec={multiWidgetSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Barras")).toBeInTheDocument();
      expect(screen.getByText("Lineas")).toBeInTheDocument();
      expect(screen.getByText("Area")).toBeInTheDocument();
      expect(screen.getByText("Donut")).toBeInTheDocument();
      expect(screen.getByText("Tabla")).toBeInTheDocument();
      expect(screen.getByText("Numero")).toBeInTheDocument();
    });
  });

  it("refetches when refreshKey changes", async () => {
    const fetchMock = mockFetchSuccess({
      columns: ["tienda", "total"],
      rows: [["Madrid", 100]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <DashboardRenderer spec={barSpec} refreshKey={0} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
    });

    const callsAfterFirst = fetchMock.mock.calls.length;

    // Increment refreshKey without changing spec
    rerender(<DashboardRenderer spec={barSpec} refreshKey={1} />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  it("shows retry button on error and re-fetches on click", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: return an error
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () =>
              Promise.resolve({
                error: "DB error",
                code: "DB_QUERY",
                requestId: "req_retry",
                timestamp: "2026-04-05T10:00:00.000Z",
              }),
          } as unknown as Response);
        }
        // Second call (retry): succeed
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              columns: ["value"],
              rows: [[99]],
            }),
        } as unknown as Response);
      }),
    );

    const errorSpec: DashboardSpec = {
      title: "Panel con Error",
      widgets: [
        {
          type: "number",
          title: "Numero con Fallo",
          sql: "SELECT bad",
          format: "number",
        },
      ],
    };

    render(<DashboardRenderer spec={errorSpec} />);

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByTestId("retry-button")).toBeInTheDocument();
    });

    const callsBeforeRetry = callCount;

    // Click retry
    fireEvent.click(screen.getByTestId("retry-button"));

    // After retry, fetch should have been called again
    await waitFor(() => {
      expect(callCount).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it("refetches when spec changes", async () => {
    const fetchMock = mockFetchSuccess({
      columns: ["tienda", "total"],
      rows: [["Madrid", 100]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<DashboardRenderer spec={barSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
    });

    // Record call count after first spec's fetches
    const callsAfterFirst = fetchMock.mock.calls.length;

    const newSpec: DashboardSpec = {
      title: "Nuevo Panel",
      widgets: [
        {
          type: "number",
          title: "Nuevo Numero",
          sql: "SELECT 99",
          format: "number",
        },
      ],
    };

    rerender(<DashboardRenderer spec={newSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Nuevo Numero")).toBeInTheDocument();
    });

    // Verify additional fetch calls were made for the new spec
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    // The last call should contain the new widget's SQL
    const lastCallBody = JSON.parse(
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body
    );
    expect(lastCallBody.sql).toBe("SELECT 99");
  });

  it("renders tab navigation when spec has sections", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["value"],
      rows: [[42]],
    }));

    const tabbedSpec: DashboardSpec = {
      title: "Panel con Pestañas",
      widgets: [
        { id: "w1", type: "number", title: "Widget Resumen", sql: "SELECT 1", format: "number" },
        { id: "w2", type: "number", title: "Widget Detalle", sql: "SELECT 2", format: "number" },
      ],
      sections: [
        { id: "s1", label: "Resumen", widget_ids: ["w1"] },
        { id: "s2", label: "Detalle", widget_ids: ["w2"] },
      ],
    };

    render(<DashboardRenderer spec={tabbedSpec} />);

    // Tab labels should be visible
    expect(screen.getByText("Resumen")).toBeInTheDocument();
    expect(screen.getByText("Detalle")).toBeInTheDocument();
  });

  it("shows correct widgets when switching between tabs", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["value"],
      rows: [[42]],
    }));

    const tabbedSpec: DashboardSpec = {
      title: "Panel con Pestañas",
      widgets: [
        { id: "w1", type: "number", title: "Widget Resumen", sql: "SELECT 1", format: "number" },
        { id: "w2", type: "number", title: "Widget Detalle", sql: "SELECT 2", format: "number" },
      ],
      sections: [
        { id: "s1", label: "Resumen", widget_ids: ["w1"] },
        { id: "s2", label: "Detalle", widget_ids: ["w2"] },
      ],
    };

    render(<DashboardRenderer spec={tabbedSpec} />);

    // First tab (Resumen) is selected by default — wait for widget to load
    await waitFor(() => {
      expect(screen.getByText("Widget Resumen")).toBeInTheDocument();
    });

    // Switch to the second tab (Detalle)
    fireEvent.click(screen.getByRole("tab", { name: "Detalle" }));

    // Widget Detalle should now be visible
    await waitFor(() => {
      expect(screen.getByText("Widget Detalle")).toBeInTheDocument();
    });
  });

  it("renders flat layout when spec has no sections (backwards compatible)", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["tienda", "total"],
      rows: [["Madrid", 100]],
    }));

    render(<DashboardRenderer spec={barSpec} />);

    await waitFor(() => {
      expect(screen.getByText("Ventas por Tienda")).toBeInTheDocument();
    });
    // No tab elements
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("silently skips widget_ids that do not match any widget id", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess({
      columns: ["value"],
      rows: [[99]],
    }));

    const specWithBadIds: DashboardSpec = {
      title: "Panel con IDs Inválidos",
      widgets: [
        { id: "w1", type: "number", title: "Widget Válido", sql: "SELECT 1", format: "number" },
      ],
      sections: [
        { id: "s1", label: "Tab", widget_ids: ["w1", "nonexistent-id"] },
      ],
    };

    render(<DashboardRenderer spec={specWithBadIds} />);

    // Should still render without crashing; valid widget eventually loads
    await waitFor(() => {
      expect(screen.getByText("Widget Válido")).toBeInTheDocument();
    });
  });

  describe("date token substitution (buildMainSql)", () => {
    const dateRange: DateRange = {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T00:00:00.000Z"),
    };

    const tokenSpec: DashboardSpec = {
      title: "Token Test",
      widgets: [
        {
          type: "number",
          title: "Ventas",
          sql: "SELECT SUM(total) FROM ps_ventas WHERE fecha >= :curr_from AND fecha <= :curr_to",
          format: "currency",
        },
      ],
    };

    it("substitutes :curr_from and :curr_to tokens when dateRange is provided", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[1000]] });
      vi.stubGlobal("fetch", fetchMock);

      render(<DashboardRenderer spec={tokenSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.sql).toContain("'2026-03-01'");
      expect(body.sql).toContain("'2026-03-31'");
      expect(body.sql).not.toContain(":curr_from");
      expect(body.sql).not.toContain(":curr_to");
    });

    it("passes SQL unchanged when no dateRange is provided (backwards compatible)", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[1000]] });
      vi.stubGlobal("fetch", fetchMock);

      render(<DashboardRenderer spec={tokenSpec} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.sql).toContain(":curr_from");
      expect(body.sql).toContain(":curr_to");
    });

    it("substitutes tokens in kpi_row item SQL when dateRange is provided", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["value"], rows: [[42]] });
      vi.stubGlobal("fetch", fetchMock);

      const kpiTokenSpec: DashboardSpec = {
        title: "KPI Token Test",
        widgets: [
          {
            type: "kpi_row",
            items: [
              {
                label: "Ventas",
                sql: "SELECT SUM(total) FROM ps_ventas WHERE fecha >= :curr_from AND fecha <= :curr_to",
                format: "currency",
              },
            ],
          },
        ],
      };

      render(<DashboardRenderer spec={kpiTokenSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.sql).toContain("'2026-03-01'");
      expect(body.sql).toContain("'2026-03-31'");
      expect(body.sql).not.toContain(":curr_from");
      expect(body.sql).not.toContain(":curr_to");
    });

    it("SQL without tokens passes through unchanged when dateRange is provided", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[500]] });
      vi.stubGlobal("fetch", fetchMock);

      const noTokenSpec: DashboardSpec = {
        title: "No Token Test",
        widgets: [
          {
            type: "number",
            title: "Static",
            sql: "SELECT SUM(total) FROM ps_ventas",
            format: "number",
          },
        ],
      };

      render(<DashboardRenderer spec={noTokenSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.sql).toBe("SELECT SUM(total) FROM ps_ventas");
    });

    describe("trend_sql token handling", () => {
      const dateRange: DateRange = {
        from: new Date("2026-03-01T00:00:00.000Z"),
        to: new Date("2026-03-31T00:00:00.000Z"),
      };

      const trendSpec: DashboardSpec = {
        title: "KPI Trend Test",
        widgets: [
          {
            type: "kpi_row",
            items: [
              {
                label: "Ventas",
                sql: "SELECT SUM(total) FROM ps_ventas WHERE fecha >= :curr_from AND fecha <= :curr_to",
                format: "currency",
                trend_sql:
                  "SELECT SUM(total) FROM ps_ventas WHERE fecha BETWEEN :comp_from AND :comp_to",
              },
            ],
          },
        ],
      };

      it("skips trend_sql fetch when comparisonRange is undefined — no :comp_* tokens sent to PG", async () => {
        const fetchMock = mockFetchSuccess({ columns: ["value"], rows: [[500]] });
        vi.stubGlobal("fetch", fetchMock);

        render(<DashboardRenderer spec={trendSpec} dateRange={dateRange} />);

        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalled();
        });

        // No call should contain :comp_from or :comp_to
        const bodies = fetchMock.mock.calls.map((c: unknown[]) =>
          JSON.parse((c[1] as { body: string }).body)
        );
        const hasCompToken = bodies.some(
          (b: { sql: string }) =>
            b.sql.includes(":comp_from") || b.sql.includes(":comp_to")
        );
        expect(hasCompToken).toBe(false);
      });

      it("fetches trend_sql via buildComparisonSql when comparisonRange is defined", async () => {
        const fetchMock = mockFetchSuccess({ columns: ["value"], rows: [[400]] });
        vi.stubGlobal("fetch", fetchMock);

        const comparisonRange: ComparisonRange = {
          type: "previous_month",
          from: new Date("2026-02-01T00:00:00.000Z"),
          to: new Date("2026-02-28T00:00:00.000Z"),
        };

        render(
          <DashboardRenderer
            spec={trendSpec}
            dateRange={dateRange}
            comparisonRange={comparisonRange}
          />
        );

        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        const bodies = fetchMock.mock.calls.map((c: unknown[]) =>
          JSON.parse((c[1] as { body: string }).body)
        );
        const trendCall = bodies.find(
          (b: { sql: string }) =>
            b.sql.includes("2026-02-01") || b.sql.includes("2026-02-28")
        );
        expect(trendCall).toBeDefined();
        expect(trendCall.sql).not.toContain(":comp_from");
        expect(trendCall.sql).not.toContain(":comp_to");
      });
    });

    it("refetches with substituted SQL when dateRange changes", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[1000]] });
      vi.stubGlobal("fetch", fetchMock);

      const { rerender } = render(
        <DashboardRenderer spec={tokenSpec} dateRange={dateRange} />,
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const callsAfterFirst = fetchMock.mock.calls.length;

      const newDateRange: DateRange = {
        from: new Date("2026-04-01T00:00:00.000Z"),
        to: new Date("2026-04-30T00:00:00.000Z"),
      };

      rerender(<DashboardRenderer spec={tokenSpec} dateRange={newDateRange} />);

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      });

      const lastBody = JSON.parse(
        fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body,
      );
      expect(lastBody.sql).toContain("'2026-04-01'");
      expect(lastBody.sql).toContain("'2026-04-30'");
    });

    it("substitutes :comp_from/:comp_to in main sql when comparisonRange is set", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[1000]] });
      vi.stubGlobal("fetch", fetchMock);

      const compTokenSpec: DashboardSpec = {
        title: "Comp Token Test",
        widgets: [
          {
            type: "number",
            title: "Comp Value",
            sql: "SELECT SUM(v) FROM t WHERE fecha >= :comp_from AND fecha <= :comp_to",
            format: "number",
          },
        ],
      };

      const compRange: ComparisonRange = {
        from: new Date("2026-02-01T00:00:00.000Z"),
        to: new Date("2026-02-28T00:00:00.000Z"),
        type: "previous_month",
      };

      render(
        <DashboardRenderer
          spec={compTokenSpec}
          dateRange={dateRange}
          comparisonRange={compRange}
        />,
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.sql).toContain("'2026-02-01'");
      expect(body.sql).toContain("'2026-02-28'");
      expect(body.sql).not.toContain(":comp_from");
      expect(body.sql).not.toContain(":comp_to");
    });
  });

  describe(":comp_* token pre-flight check", () => {
    const compKpiSpec: DashboardSpec = {
      title: "KPI Comparativa",
      widgets: [
        {
          type: "kpi_row",
          items: [
            {
              label: "Ventas Período Anterior",
              sql: "SELECT SUM(total_si) FROM ps_ventas WHERE fecha >= :comp_from AND fecha <= :comp_to",
              format: "currency",
            },
          ],
        },
      ],
    };

    it("shows friendly error when kpi_row item sql has :comp_from but no comparisonRange", async () => {
      vi.stubGlobal("fetch", vi.fn());

      render(<DashboardRenderer spec={compKpiSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(screen.getByText("Este panel requiere seleccionar un período de comparación")).toBeInTheDocument();
      });

      // fetch should never be called — the pre-flight check blocks it
      expect(fetch).not.toHaveBeenCalled();
    });

    it("fetches main sql and silently skips trend_sql when only trend_sql has :comp_from but no comparisonRange", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["sum"], rows: [[500]] });
      vi.stubGlobal("fetch", fetchMock);

      const compTrendSpec: DashboardSpec = {
        title: "KPI Trend Comparativa",
        widgets: [
          {
            type: "kpi_row",
            items: [
              {
                label: "Ventas",
                sql: "SELECT SUM(total_si) FROM ps_ventas",
                trend_sql: "SELECT SUM(total_si) FROM ps_ventas WHERE fecha >= :comp_from AND fecha <= :comp_to",
                format: "currency",
              },
            ],
          },
        ],
      };

      render(<DashboardRenderer spec={compTrendSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const bodies = fetchMock.mock.calls.map((c: unknown[]) =>
        JSON.parse((c[1] as { body: string }).body)
      );
      const hasCompToken = bodies.some(
        (b: { sql: string }) =>
          b.sql.includes(":comp_from") || b.sql.includes(":comp_to")
      );
      expect(hasCompToken).toBe(false);
    });

    const compSqlSpec: DashboardSpec = {
      title: "Comparativa",
      widgets: [
        {
          id: "w1",
          type: "table",
          title: "Variación por Tienda",
          sql: "SELECT tienda, SUM(CASE WHEN fecha >= :comp_from AND fecha <= :comp_to THEN total END) AS anterior FROM ps_ventas GROUP BY tienda",
        },
      ],
    };

    const dateRange: DateRange = {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T00:00:00.000Z"),
    };

    it("shows friendly error when table widget main sql has :comp_from but no comparisonRange", async () => {
      vi.stubGlobal("fetch", vi.fn());

      render(<DashboardRenderer spec={compSqlSpec} dateRange={dateRange} />);

      await waitFor(() => {
        expect(screen.getByText("Este panel requiere seleccionar un período de comparación")).toBeInTheDocument();
      });

      // fetch should never be called — the pre-flight check blocks it
      expect(fetch).not.toHaveBeenCalled();
    });

    it("sends SQL params when spec uses __gf tokens and globalFilterValues are set", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["value"], rows: [[1]] });
      vi.stubGlobal("fetch", fetchMock);

      const specWithFilters: DashboardSpec = {
        title: "Con filtros",
        filters: [
          {
            id: "tienda",
            type: "single_select",
            label: "Tienda",
            bind_expr: `v."tienda"`,
            value_type: "text",
            options_sql: "SELECT 1 AS value, 1 AS label",
          },
        ],
        widgets: [
          {
            type: "number",
            title: "N",
            sql: 'SELECT 1 AS value FROM "public"."ps_ventas" v WHERE __gf_tienda__',
            format: "number",
          },
        ],
      };

      const { rerender } = render(
        <DashboardRenderer
          spec={specWithFilters}
          globalFilterValues={{ tienda: "01" }}
          refreshKey={0}
        />,
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(firstBody.sql).toContain("$1::text");
      expect(firstBody.params).toEqual(["01"]);

      rerender(
        <DashboardRenderer
          spec={specWithFilters}
          globalFilterValues={{ tienda: "02" }}
          refreshKey={1}
        />,
      );

      await waitFor(() => {
        const last = JSON.parse(
          fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body as string,
        );
        expect(last.params).toEqual(["02"]);
      });
    });

    it("calls fetchWidgetData with substituted SQL (no :comp_*) when comparisonRange is set", async () => {
      const fetchMock = mockFetchSuccess({ columns: ["tienda", "anterior"], rows: [["Madrid", 500]] });
      vi.stubGlobal("fetch", fetchMock);

      const compRange: ComparisonRange = {
        from: new Date("2026-02-01T00:00:00.000Z"),
        to: new Date("2026-02-28T00:00:00.000Z"),
        type: "previous_month",
      };

      render(
        <DashboardRenderer
          spec={compSqlSpec}
          dateRange={dateRange}
          comparisonRange={compRange}
        />,
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // comp tokens must be substituted
      expect(body.sql).not.toContain(":comp_from");
      expect(body.sql).not.toContain(":comp_to");
      // substituted with actual dates
      expect(body.sql).toContain("'2026-02-01'");
      expect(body.sql).toContain("'2026-02-28'");
    });
  });
});
