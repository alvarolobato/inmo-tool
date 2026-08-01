import { describe, it, expect } from "vitest";
import { compileGlobalFilterSql, listReferencedGlobalFilterIds } from "../sql-filters";
import type { DashboardSpec } from "../schema";

const FILTERS_SPEC: Pick<DashboardSpec, "filters"> = {
  filters: [
    {
      id: "tienda",
      type: "single_select",
      label: "Tienda",
      bind_expr: `v."tienda"`,
      value_type: "text",
      options_sql: "SELECT 1",
    },
    {
      id: "familia",
      type: "multi_select",
      label: "Familia",
      bind_expr: `fm."fami_grup_marc"`,
      value_type: "text",
      options_sql: "SELECT 1",
    },
  ],
};

describe("compileGlobalFilterSql", () => {
  it("replaces inactive single_select with TRUE", () => {
    const { sql, params } = compileGlobalFilterSql(
      `SELECT 1 WHERE __gf_tienda__`,
      FILTERS_SPEC.filters,
      {},
    );
    expect(sql).toBe("SELECT 1 WHERE TRUE");
    expect(params).toEqual([]);
  });

  it("binds active single_select as parameterized equality", () => {
    const { sql, params } = compileGlobalFilterSql(
      `SELECT 1 WHERE __gf_tienda__`,
      FILTERS_SPEC.filters,
      { tienda: "01" },
    );
    expect(sql).toBe(`SELECT 1 WHERE ((v."tienda") = $1::text)`);
    expect(params).toEqual(["01"]);
  });

  it("binds multi_select with ANY", () => {
    const { sql, params } = compileGlobalFilterSql(
      `SELECT 1 WHERE __gf_familia__`,
      FILTERS_SPEC.filters,
      { familia: ["A", "B"] },
    );
    expect(sql).toBe(`SELECT 1 WHERE ((fm."fami_grup_marc") = ANY($1::text[]))`);
    expect(params).toEqual([["A", "B"]]);
  });

  it("binds numeric single_select from string or number", () => {
    const filters = [
      {
        id: "n",
        type: "single_select" as const,
        label: "N",
        bind_expr: "t.x",
        value_type: "numeric" as const,
        options_sql: "SELECT 1",
      },
    ];
    const a = compileGlobalFilterSql(`SELECT 1 WHERE __gf_n__`, filters, { n: "42" });
    expect(a.params).toEqual([42]);
    const b = compileGlobalFilterSql(`SELECT 1 WHERE __gf_n__`, filters, { n: 7 });
    expect(b.params).toEqual([7]);
  });

  it("binds numeric multi_select arrays", () => {
    const filters = [
      {
        id: "n",
        type: "multi_select" as const,
        label: "N",
        bind_expr: "t.x",
        value_type: "numeric" as const,
        options_sql: "SELECT 1",
      },
    ];
    const { sql, params } = compileGlobalFilterSql(`WHERE __gf_n__`, filters, {
      n: [1, 2, 3],
    });
    expect(sql).toContain("::numeric[]");
    expect(params).toEqual([[1, 2, 3]]);
  });

  it("excludeFilterId forces TRUE for that token", () => {
    const { sql } = compileGlobalFilterSql(
      `SELECT 1 WHERE __gf_tienda__ AND __gf_familia__`,
      FILTERS_SPEC.filters,
      { tienda: "01", familia: ["X"] },
      { excludeFilterId: "familia" },
    );
    expect(sql).toContain("TRUE");
    expect(sql).toContain("$1::text");
    expect(sql).not.toContain("fami_grup_marc");
  });
});

describe("listReferencedGlobalFilterIds", () => {
  it("lists unique ids", () => {
    expect(
      listReferencedGlobalFilterIds(`__gf_tienda__ AND __gf_familia__ OR __gf_tienda__`),
    ).toEqual(["familia", "tienda"]);
  });
});
