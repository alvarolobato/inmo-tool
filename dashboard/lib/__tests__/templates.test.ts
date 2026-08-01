import { describe, it, expect } from "vitest";
import { TEMPLATES, type DashboardTemplate } from "../templates";
import { validateSpec, DashboardSpecSchema } from "../schema";
import { lintDashboardSpec, collectWidgetSqlStrings } from "../sql-heuristics";

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe("TEMPLATES array", () => {
  it("exports exactly 6 templates", () => {
    expect(TEMPLATES).toHaveLength(6);
  });

  it("has unique slugs", () => {
    const slugs = TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every template has a non-empty name and description", () => {
    for (const t of TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Zod validation for each template spec
// ---------------------------------------------------------------------------

describe.each(TEMPLATES.map((t) => [t.slug, t] as [string, DashboardTemplate]))(
  "template '%s' passes Zod validation",
  (_slug, template) => {
    it("validateSpec does not throw", () => {
      expect(() => validateSpec(template.spec)).not.toThrow();
    });

    it("safeParse returns success", () => {
      const result = DashboardSpecSchema.safeParse(template.spec);
      expect(result.success).toBe(true);
    });

    it("has a non-empty title in the spec", () => {
      expect(template.spec.title.length).toBeGreaterThan(0);
    });

    it("has at least one widget", () => {
      expect(template.spec.widgets.length).toBeGreaterThanOrEqual(1);
    });

    it("every widget SQL is non-empty", () => {
      for (const widget of template.spec.widgets) {
        if (widget.type === "kpi_row") {
          for (const item of widget.items) {
            expect(item.sql.trim().length).toBeGreaterThan(0);
          }
        } else {
          expect(widget.sql.trim().length).toBeGreaterThan(0);
        }
      }
    });

    it("every widget SQL references ps_* tables", () => {
      const allSql: string[] = [];
      for (const widget of template.spec.widgets) {
        if (widget.type === "kpi_row") {
          for (const item of widget.items) {
            allSql.push(item.sql);
          }
        } else {
          allSql.push(widget.sql);
        }
      }
      for (const sql of allSql) {
        expect(sql).toMatch(/ps_/);
      }
    });

    it("every widget SQL with a date filter uses :curr_from / :curr_to tokens, unless explicitly point-in-time (CURRENT_DATE)", () => {
      const allSql: string[] = [];
      for (const widget of template.spec.widgets) {
        if (widget.type === "kpi_row") {
          for (const item of widget.items) {
            allSql.push(item.sql);
          }
        } else {
          allSql.push(widget.sql);
        }
      }
      for (const sql of allSql) {
        // Point-in-time widgets (e.g. coverage/stock-cobertura-critica) anchor on
        // CURRENT_DATE by design — they must NOT use :curr_from/:curr_to. All
        // other date-filtered widgets must use the parameterised tokens.
        if (/>=|<=|BETWEEN/.test(sql) && /date|fecha/i.test(sql) && !/CURRENT_DATE/.test(sql)) {
          expect(sql).toMatch(/:curr_from/);
          expect(sql).toMatch(/:curr_to/);
        } else if (/>=|<=|BETWEEN/.test(sql) && /date|fecha/i.test(sql) && /CURRENT_DATE/.test(sql)) {
          expect(sql).not.toMatch(/:curr_from/);
          expect(sql).not.toMatch(/:curr_to/);
        }
      }
    });
  },
);

// ---------------------------------------------------------------------------
// SQL rule compliance
// ---------------------------------------------------------------------------

describe("SQL rule compliance across all templates", () => {
  const allSql: string[] = [];
  for (const t of TEMPLATES) {
    allSql.push(...collectWidgetSqlStrings(t.spec));
  }

  it("passes PostgreSQL SQL heuristics (EXTRACT days / COALESCE date+text)", () => {
    for (const t of TEMPLATES) {
      expect(lintDashboardSpec(t.spec), `template ${t.slug}`).toEqual([]);
    }
  });

  it("never uses the 'total' column without _si suffix for retail ventas", () => {
    for (const sql of allSql) {
      if (/ps_ventas/.test(sql) || /ps_lineas_ventas/.test(sql)) {
        // Should not have standalone "total" as aggregate target (total_si is ok)
        // Match SUM("total") or SUM(total) but not SUM("total_si") or SUM("total_coste_si")
        expect(sql).not.toMatch(/SUM\(\s*"?total"?\s*\)(?!_)/);
      }
    }
  });

  it("never uses fecha_documento", () => {
    for (const sql of allSql) {
      expect(sql).not.toMatch(/fecha_documento/);
    }
  });

  it("retail ventas queries exclude tienda 99", () => {
    for (const sql of allSql) {
      if (/ps_ventas/.test(sql) || /ps_lineas_ventas/.test(sql)) {
        expect(sql).toMatch(/"?tienda"?\s*(<>|!=)\s*'99'/);
      }
    }
  });

  it("all time-filtered SQL contains both :curr_from and :curr_to tokens (unless point-in-time with CURRENT_DATE)", () => {
    for (const sql of allSql) {
      // Point-in-time coverage widgets use CURRENT_DATE and are exempt from the
      // :curr_from/:curr_to requirement — but they must not mix in those tokens.
      if (/>=|<=|BETWEEN/.test(sql) && /date|fecha/i.test(sql) && !/CURRENT_DATE/.test(sql)) {
        expect(sql).toMatch(/:curr_from/);
        expect(sql).toMatch(/:curr_to/);
      } else if (/>=|<=|BETWEEN/.test(sql) && /date|fecha/i.test(sql) && /CURRENT_DATE/.test(sql)) {
        expect(sql).not.toMatch(/:curr_from/);
        expect(sql).not.toMatch(/:curr_to/);
      }
    }
  });

  it("YoY-style SQL uses :curr_*::date before INTERVAL (avoids PG 'invalid input syntax for type interval')", () => {
    const general = TEMPLATES.find((t) => t.slug === "general");
    expect(general).toBeDefined();
    const kpi = general!.spec.widgets.find((w) => w.id === "general-kpis");
    expect(kpi?.type).toBe("kpi_row");
    if (kpi?.type !== "kpi_row") {
      expect.fail("general-kpis must be kpi_row");
    }
    const yoyItem = kpi.items.find((i) => i.label === "Retail YoY %");
    expect(yoyItem).toBeDefined();
    const sql = yoyItem!.sql;
    expect(sql).toMatch(/:curr_from::date\s*-\s*INTERVAL\s+'1 year'/);
    expect(sql).toMatch(/:curr_to::date\s*-\s*INTERVAL\s+'1 year'/);
  });
});

// ---------------------------------------------------------------------------
// Mayorista-specific invariants (issue #416)
// ---------------------------------------------------------------------------

describe("template 'mayorista' wholesale-channel invariants", () => {
  const mayorista = TEMPLATES.find((t) => t.slug === "mayorista");
  if (!mayorista) {
    throw new Error("mayorista template not registered in TEMPLATES");
  }
  const allSql = collectWidgetSqlStrings(mayorista.spec);

  it("never joins line.num_<parent> against header.n_<parent> for any GC alias/order", () => {
    // Regression guard: the line.num_<parent> column matches the header's
    // record id (reg_*), not the human number n_*. Joining on n_<parent>
    // is a silent zero-row bug — see mayorista.ts header comment.
    //
    // We test BOTH orderings (line.num=header.n AND header.n=line.num)
    // and accept ANY alias (one or more letters), so a future widget
    // that aliases ps_gc_facturas as `g`, `gf`, `hdr`, etc. is still
    // covered. We also accept arbitrary whitespace and the optional
    // double-quoted variant for each identifier.
    const FORBIDDEN_PARENTS = ["factura", "albaran", "pedido"];
    for (const sql of allSql) {
      for (const parent of FORBIDDEN_PARENTS) {
        // Order A: <alias>.num_<parent> = <alias>.n_<parent>
        const re1 = new RegExp(
          String.raw`\b[A-Za-z_][A-Za-z0-9_]*\."?num_${parent}"?\s*=\s*[A-Za-z_][A-Za-z0-9_]*\."?n_${parent}"?\b`,
          "i",
        );
        // Order B: <alias>.n_<parent> = <alias>.num_<parent>
        const re2 = new RegExp(
          String.raw`\b[A-Za-z_][A-Za-z0-9_]*\."?n_${parent}"?\s*=\s*[A-Za-z_][A-Za-z0-9_]*\."?num_${parent}"?\b`,
          "i",
        );
        expect(
          sql,
          `join key for ps_gc_lin_${parent}s must be num_${parent} = reg_${parent}, never n_${parent} (any alias/order)`,
        ).not.toMatch(re1);
        expect(
          sql,
          `join key for ps_gc_lin_${parent}s must be num_${parent} = reg_${parent}, never n_${parent} (any alias/order)`,
        ).not.toMatch(re2);
      }
    }
  });

  it("aggregates base1+base2+base3 NULL-safely (COALESCE-wrapped inside SUM)", () => {
    // Regression guard: ps_gc_facturas.base1/2/3 are nullable in the
    // schema (numeric(15,2), no NOT NULL). A bare `SUM(base1+base2+base3)`
    // drops the entire row from the aggregate when ANY of the three is
    // NULL (PG's + propagates NULL → SUM ignores NULL row contributions).
    // Every base-arithmetic SUM in the mayorista template must wrap each
    // base in COALESCE(..., 0). See Opus review #425.
    for (const sql of allSql) {
      const sumMatches = sql.match(
        /SUM\s*\([^()]*(?:\([^()]*\)[^()]*)*base1[^()]*(?:\([^()]*\)[^()]*)*base2[^()]*(?:\([^()]*\)[^()]*)*base3[^()]*\)/gi,
      );
      if (!sumMatches) continue;
      for (const m of sumMatches) {
        for (const col of ["base1", "base2", "base3"]) {
          expect(
            m,
            `SUM expression must COALESCE ${col} to 0 (NULL-safe): "${m.trim()}"`,
          ).toMatch(new RegExp(String.raw`COALESCE\s*\([^)]*${col}[^)]*\)`, "i"));
        }
      }
    }
  });

  it("does not filter GC widgets by ccrefejofacm M-prefix (channel is table-defined)", () => {
    // Wholesale data lives in ps_gc_* by definition; adding `ccrefejofacm
    // LIKE 'M%'` here would drop ~96% of legitimate wholesale invoice
    // lines, since most reference retail-coded articles. See header
    // comment in mayorista.ts.
    for (const sql of allSql) {
      expect(sql).not.toMatch(/ccrefejofacm.+LIKE\s+'M%'/i);
      expect(sql).not.toMatch(/codigo\s+LIKE\s+'M%'/i);
    }
  });

  it("never invokes the int16 stock decoder on GC quantity columns (D-017)", () => {
    // The signed-int16 word decode applies only to Exportaciones.Stock1..34;
    // GC line quantities (unidades / total / total_coste) are 4D Reals and
    // can exceed 32767 legitimately.
    for (const sql of allSql) {
      expect(sql).not.toMatch(/decode_signed_int16_word/i);
    }
  });
});
