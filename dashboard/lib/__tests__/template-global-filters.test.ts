import { describe, it, expect } from "vitest";
import {
  templateGlobalFiltersRetail,
  templateGlobalFiltersMayorista,
  templateGlobalFiltersStock,
  templateGlobalFiltersCompras,
} from "../template-global-filters";
import { compileGlobalFilterSql, listReferencedGlobalFilterIds } from "../sql-filters";
import { TEMPLATES } from "../templates";
import { GlobalFilterSchema } from "../schema";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

const ALL_SETS = {
  retail: templateGlobalFiltersRetail,
  mayorista: templateGlobalFiltersMayorista,
  stock: templateGlobalFiltersStock,
  compras: templateGlobalFiltersCompras,
};

describe.each(Object.entries(ALL_SETS))("template-global-filters: %s set", (name, set) => {
  it(`${name} set has at least one filter`, () => {
    expect(set.length).toBeGreaterThanOrEqual(1);
  });

  it(`${name} filters each pass GlobalFilterSchema`, () => {
    for (const f of set) {
      const res = GlobalFilterSchema.safeParse(f);
      expect(res.success, `${f.id} should be valid`).toBe(true);
    }
  });

  it(`${name} filter ids are unique within the set`, () => {
    const ids = set.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(`${name} options_sql returns value + label (lexical check)`, () => {
    for (const f of set) {
      expect(f.options_sql).toMatch(/\bAS\s+value\b/i);
      expect(f.options_sql).toMatch(/\bAS\s+label\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Retail set must cover issue #401 requirements
// ---------------------------------------------------------------------------

describe("retail filter coverage", () => {
  it("includes tienda, familia, temporada, marca, sexo, departamento", () => {
    const ids = templateGlobalFiltersRetail.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tienda",
        "familia",
        "temporada",
        "marca",
        "sexo",
        "departamento",
      ]),
    );
  });
});

describe("mayorista filter coverage", () => {
  it("includes cliente_mayorista, familia, temporada, marca", () => {
    const ids = templateGlobalFiltersMayorista.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(["cliente_mayorista", "familia", "temporada", "marca"]),
    );
  });
});

describe("stock filter coverage", () => {
  it("includes tienda, familia, temporada", () => {
    const ids = templateGlobalFiltersStock.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["tienda", "familia", "temporada"]));
  });
});

describe("compras filter coverage", () => {
  it("includes proveedor_compras", () => {
    const ids = templateGlobalFiltersCompras.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["proveedor_compras"]));
  });

  // Guardrail: we removed familia/temporada from compras because no compras
  // widget joins ps_lineas_compras → ps_articulos → ps_familias. If someone
  // wires those joins in later, they should add the filter AND remove this
  // exclusion rather than silently reintroducing dead chrome.
  it("does NOT include familia or temporada (no compras widget joins articulos)", () => {
    const ids = templateGlobalFiltersCompras.map((f) => f.id);
    expect(ids).not.toContain("familia");
    expect(ids).not.toContain("temporada");
  });
});

// ---------------------------------------------------------------------------
// compileGlobalFilterSql integration: every filter in every set behaves right
// both when inactive (TRUE) and active (IN fragment). This catches any typo
// in bind_expr or value_type that would break the pipeline at runtime.
// ---------------------------------------------------------------------------

describe("filter compilation — inactive yields TRUE, active yields parameterized WHERE", () => {
  for (const [setName, filters] of Object.entries(ALL_SETS)) {
    for (const filter of filters) {
      const token = `__gf_${filter.id}__`;
      const baseSql = `SELECT 1 WHERE ${token}`;

      it(`${setName}.${filter.id}: inactive → TRUE`, () => {
        const { sql, params } = compileGlobalFilterSql(baseSql, filters, {});
        expect(sql).toBe("SELECT 1 WHERE TRUE");
        expect(params).toEqual([]);
      });

      it(`${setName}.${filter.id}: active emits parameterized fragment`, () => {
        const sample =
          filter.type === "single_select"
            ? filter.value_type === "numeric"
              ? 42
              : "SAMPLE"
            : filter.value_type === "numeric"
              ? [1, 2]
              : ["A", "B"];
        const { sql, params } = compileGlobalFilterSql(baseSql, filters, {
          [filter.id]: sample,
        });
        expect(sql).not.toContain(token);
        expect(sql).toContain("$1");
        expect(params).toHaveLength(1);
        if (filter.type === "multi_select") {
          expect(Array.isArray(params[0])).toBe(true);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Every widget SQL in every template compiles cleanly with every declared
// template-filter inactive. This guarantees that adding new `__gf_*__` tokens
// doesn't break widgets that don't reference them (they remain untouched)
// and tokens present in widget SQL resolve to TRUE without parameters.
// ---------------------------------------------------------------------------

describe("widget SQL + filter pipeline — empty selections keep SQL valid", () => {
  for (const template of TEMPLATES) {
    it(`${template.slug}: every widget SQL compiles with no active filters`, () => {
      const filters = template.spec.filters ?? [];
      for (const widget of template.spec.widgets) {
        const sqlStrings: string[] =
          widget.type === "kpi_row"
            ? widget.items.map((i) => i.sql)
            : [widget.sql];
        for (const rawSql of sqlStrings) {
          const { sql, params } = compileGlobalFilterSql(rawSql, filters, {});
          // Every token referenced in the widget SQL must belong to the
          // template filter set — otherwise it would remain unreplaced.
          const remaining = listReferencedGlobalFilterIds(sql);
          expect(remaining, `widget with orphan filter tokens: ${remaining.join(",")}`).toEqual([]);
          // Inactive compile never emits params.
          expect(params).toEqual([]);
        }
      }
    });
  }
});

describe("widget SQL references only known template filter ids", () => {
  for (const template of TEMPLATES) {
    it(`${template.slug}: every __gf_<id>__ token in widget SQL is declared in spec.filters`, () => {
      const declared = new Set((template.spec.filters ?? []).map((f) => f.id));
      for (const widget of template.spec.widgets) {
        const sqlStrings: string[] =
          widget.type === "kpi_row"
            ? widget.items.map((i) => i.sql)
            : [widget.sql];
        for (const sql of sqlStrings) {
          for (const id of listReferencedGlobalFilterIds(sql)) {
            expect(declared.has(id), `${template.slug} references undeclared filter id ${id}`).toBe(true);
          }
        }
      }
    });
  }
});
