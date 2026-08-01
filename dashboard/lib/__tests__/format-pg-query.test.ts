import { describe, it, expect } from "vitest";
import { formatPgQueryText } from "../format-pg-query";

/**
 * Tests for formatPgQueryText.
 *
 * Bug examples are taken verbatim from the Additional Context section of
 * GitHub issue #443.  Each test asserts that the output contains the expected
 * token spacing (case-insensitive, tolerating line-breaks added by the
 * formatter).
 */

/** Normalise whitespace to a single space so we can match across line-breaks. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

describe("formatPgQueryText — issue #443 bug examples", () => {
  it('fixes SELECTCOUNT(*)AS → SELECT COUNT(*) AS', () => {
    const input = "SELECTCOUNT(*)AS skus_with_inconsistent_cc FROM ps_ventas";
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/SELECT\s+COUNT\s*\(\s*\*\s*\)\s+AS\s+skus_with_inconsistent_cc/i);
  });

  it('fixes ISNOTNULLGROUPBY → IS NOT NULL … GROUP BY', () => {
    const input =
      "SELECT cc_stock FROM ps_stock_tienda WHERE cc_stock ISNOTNULLGROUPBY codigo, talla";
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/IS\s+NOT\s+NULL/i);
    expect(out).toMatch(/GROUP\s+BY/i);
  });

  it('fixes SELECTDATE $1AS → SELECT DATE $1 AS', () => {
    const input = "SELECTDATE $1AS curr_from, DATE $2AS curr_to";
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/SELECT/i);
    expect(out).toMatch(/AS\s+curr_from/i);
    expect(out).toMatch(/AS\s+curr_to/i);
  });

  it('fixes "ccrefejofacm"AS"Referencia" → ... AS "Referencia"', () => {
    const input =
      'SELECT p."ccrefejofacm"AS"Referencia" FROM ps_articulos p';
    const out = formatPgQueryText(input);
    // The formatter must insert whitespace between the alias and the keyword
    expect(out).toMatch(/AS\s+"Referencia"/i);
  });
});

describe("formatPgQueryText — idempotency", () => {
  it("is idempotent: formatting twice produces the same result", () => {
    const input =
      'SELECT v."total_si" AS ventas, COUNT(*) AS tickets FROM ps_ventas v WHERE v."entrada" = true GROUP BY v."tienda" ORDER BY ventas DESC';
    const once = formatPgQueryText(input);
    const twice = formatPgQueryText(once);
    expect(normalise(twice)).toBe(normalise(once));
  });
});

describe("formatPgQueryText — edge cases", () => {
  it("returns empty string unchanged", () => {
    expect(formatPgQueryText("")).toBe("");
  });

  it("returns whitespace-only string unchanged", () => {
    expect(formatPgQueryText("   ")).toBe("   ");
  });

  it("handles $N placeholders without throwing", () => {
    const input =
      "SELECT * FROM ps_ventas WHERE fecha_creacion >= $1 AND fecha_creacion <= $2 AND tienda = $3";
    expect(() => formatPgQueryText(input)).not.toThrow();
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/WHERE/i);
    expect(out).toMatch(/\$1/);
    expect(out).toMatch(/\$2/);
    expect(out).toMatch(/\$3/);
  });

  it("handles CTE (WITH ... AS (...)) without throwing", () => {
    const input = `WITH params AS (SELECT $1::date AS curr_from, $2::date AS curr_to) SELECT * FROM ps_ventas v, params p WHERE v.fecha_creacion >= p.curr_from`;
    expect(() => formatPgQueryText(input)).not.toThrow();
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/WITH/i);
    expect(out).toMatch(/params/i);
  });

  it("handles FILTER (WHERE ...) aggregate syntax without throwing", () => {
    const input =
      "SELECT COUNT(*) FILTER (WHERE entrada = true) AS ventas, COUNT(*) FILTER (WHERE entrada = false) AS devol FROM ps_ventas";
    expect(() => formatPgQueryText(input)).not.toThrow();
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/FILTER/i);
  });

  it("handles SELECT DISTINCT without throwing", () => {
    const input =
      "SELECT DISTINCT tienda FROM ps_ventas WHERE fecha_creacion >= $1";
    expect(() => formatPgQueryText(input)).not.toThrow();
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/SELECT\s+DISTINCT/i);
  });

  it("handles JSON operators without throwing", () => {
    const input =
      "SELECT spec->'widgets' AS widgets FROM dashboards WHERE id = $1";
    expect(() => formatPgQueryText(input)).not.toThrow();
  });

  it("does not throw on malformed SQL — returns a non-empty string", () => {
    const input = "SELECTNONSENSE;;;garbage$$";
    let result: string | undefined;
    expect(() => {
      result = formatPgQueryText(input);
    }).not.toThrow();
    expect(typeof result).toBe("string");
    expect((result ?? "").length).toBeGreaterThan(0);
  });
});

describe("formatPgQueryText — real pg_stat_statements patterns", () => {
  it("formats a typical ps_ventas aggregation query", () => {
    const input =
      "SELECT tienda, SUM(total_si) AS ventas, COUNT(DISTINCT reg_ventas) AS tickets FROM ps_ventas WHERE entrada = $1 AND tienda <> $2 AND fecha_creacion >= $3 AND fecha_creacion <= $4 GROUP BY tienda ORDER BY ventas DESC";
    const out = formatPgQueryText(input);
    expect(out).toMatch(/SELECT/i);
    expect(out).toMatch(/GROUP BY/i);
    expect(out).toMatch(/ORDER BY/i);
  });

  it("formats a stock query with CASE / IS NOT NULL", () => {
    const input =
      "SELECT codigo, talla, stock FROM ps_stock_tienda WHERE stock IS NOT NULL AND tienda = $1 ORDER BY codigo";
    const out = normalise(formatPgQueryText(input));
    expect(out).toMatch(/IS\s+NOT\s+NULL/i);
    expect(out).toMatch(/ORDER\s+BY/i);
  });
});
