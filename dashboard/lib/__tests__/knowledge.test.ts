import { describe, it, expect } from "vitest";
import {
  INSTRUCTIONS,
  SQL_PAIRS,
  SCHEMA,
  RELATIONSHIPS,
} from "../knowledge";

describe("knowledge", () => {
  describe("INSTRUCTIONS", () => {
    it("contains at least 40 instructions", () => {
      expect(INSTRUCTIONS.length).toBeGreaterThanOrEqual(40);
    });

    it("each instruction has non-empty text and questions", () => {
      for (const inst of INSTRUCTIONS) {
        expect(inst.instruction.length).toBeGreaterThan(10);
        expect(inst.questions.length).toBeGreaterThan(0);
        for (const q of inst.questions) {
          expect(q.length).toBeGreaterThan(0);
        }
      }
    });

    it("includes key business rules", () => {
      const allText = INSTRUCTIONS.map((i) => i.instruction).join(" ");
      expect(allText).toContain("total_si");
      expect(allText).toContain("fecha_creacion");
      expect(allText).toContain("entrada");
      expect(allText).toContain("tienda 99");
      expect(allText).toContain("base1");
      expect(allText).toContain("ccrefejofacm");
    });
  });

  describe("SQL_PAIRS", () => {
    it("contains at least 52 SQL pairs", () => {
      expect(SQL_PAIRS.length).toBeGreaterThanOrEqual(52);
    });

    it("each pair has a question and valid-looking SQL", () => {
      for (const pair of SQL_PAIRS) {
        expect(pair.question.length).toBeGreaterThan(5);
        expect(pair.sql).toMatch(/SELECT/i);
        expect(pair.sql).toMatch(/FROM/i);
      }
    });

    it("SQL references ps_* tables", () => {
      for (const pair of SQL_PAIRS) {
        expect(pair.sql).toMatch(/ps_/);
      }
    });

    it("covers key domains", () => {
      const questions = SQL_PAIRS.map((p) => p.question).join(" ");
      expect(questions).toContain("vendidos");
      expect(questions).toContain("stock");
      expect(questions).toContain("mayorista");
      expect(questions).toContain("clientes");
      expect(questions).toContain("pago");
      expect(questions).toContain("margen");
    });

    it("SQL pairs that use :comp_* in main sql are explicitly comparison-scoped", () => {
      // :comp_* in pair.sql is reserved for documented year-over-year / comparison
      // examples. New pairs must not sneak :comp_* into non-comparison questions.
      const compTokenPattern = /:comp_(from|to|mes_from|mes_to)\b/;
      const comparisonCue =
        /comparaci|comparativa|anterior|YTD|per[ií]odo de comparaci/i;
      const pairsWithCompTokens = SQL_PAIRS.filter((pair) =>
        compTokenPattern.test(pair.sql)
      );
      expect(pairsWithCompTokens.length).toBeGreaterThanOrEqual(1);
      for (const pair of pairsWithCompTokens) {
        expect(pair.question).toMatch(comparisonCue);
      }
    });

    it("no SQL pair uses CURRENT_DATE, DATE_TRUNC with CURRENT_DATE, or bare INTERVAL", () => {
      for (const pair of SQL_PAIRS) {
        expect(pair.sql).not.toMatch(/CURRENT_DATE/);
        expect(pair.sql).not.toMatch(/\bINTERVAL\b/);
      }
    });
  });

  describe("SCHEMA", () => {
    it("contains at least 20 tables", () => {
      expect(SCHEMA.length).toBeGreaterThanOrEqual(20);
    });

    it("includes core tables", () => {
      const names = SCHEMA.map((s) => s.table);
      expect(names).toContain("ps_ventas");
      expect(names).toContain("ps_lineas_ventas");
      expect(names).toContain("ps_articulos");
      expect(names).toContain("ps_stock_tienda");
      expect(names).toContain("ps_gc_facturas");
    });

    it("each table has alias and key columns", () => {
      for (const table of SCHEMA) {
        expect(table.alias.length).toBeGreaterThan(0);
        expect(table.keyColumns.length).toBeGreaterThan(0);
      }
    });
  });

  describe("RELATIONSHIPS", () => {
    it("contains at least 19 relationships", () => {
      expect(RELATIONSHIPS.length).toBeGreaterThanOrEqual(19);
    });

    it("all relationships are MANY_TO_ONE", () => {
      for (const rel of RELATIONSHIPS) {
        expect(rel.type).toBe("MANY_TO_ONE");
      }
    });

    it("includes key join paths", () => {
      const joinPaths = RELATIONSHIPS.map(
        (r) => `${r.from}.${r.fromColumn}->${r.to}.${r.toColumn}`
      );
      expect(joinPaths).toContain(
        "ps_lineas_ventas.num_ventas->ps_ventas.reg_ventas"
      );
      expect(joinPaths).toContain(
        "ps_lineas_ventas.codigo->ps_articulos.codigo"
      );
    });
  });
});
