import { describe, it, expect } from "vitest";
import {
  CURR_FROM, CURR_TO, COMP_FROM, COMP_TO,
  CURR_MES_FROM, CURR_MES_TO, COMP_MES_FROM, COMP_MES_TO,
  substituteDateParams,
  type DateParamRanges,
} from "../date-params";

const CURR_FROM_DATE = new Date(Date.UTC(2026, 0, 1));
const CURR_TO_DATE   = new Date(Date.UTC(2026, 2, 31));
const COMP_FROM_DATE = new Date(Date.UTC(2025, 0, 1));
const COMP_TO_DATE   = new Date(Date.UTC(2025, 2, 31));

const RANGES_WITH_COMP: DateParamRanges = {
  curr: { from: CURR_FROM_DATE, to: CURR_TO_DATE },
  comp: { from: COMP_FROM_DATE, to: COMP_TO_DATE },
};

const RANGES_NO_COMP: DateParamRanges = {
  curr: { from: CURR_FROM_DATE, to: CURR_TO_DATE },
};

describe("substituteDateParams", () => {
  it("replaces :curr_from token", () => {
    const sql = "WHERE fecha >= " + CURR_FROM;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE fecha >= '2026-01-01'");
  });

  it("replaces :curr_to token", () => {
    const sql = "WHERE fecha <= " + CURR_TO;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE fecha <= '2026-03-31'");
  });

  it("replaces :comp_from token", () => {
    const sql = "WHERE fecha >= " + COMP_FROM;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE fecha >= '2025-01-01'");
  });

  it("replaces :comp_to token", () => {
    const sql = "WHERE fecha <= " + COMP_TO;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE fecha <= '2025-03-31'");
  });

  it("replaces :curr_mes_from token", () => {
    const sql = "WHERE mes >= " + CURR_MES_FROM;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE mes >= 202601");
  });

  it("replaces :curr_mes_to token", () => {
    const sql = "WHERE mes <= " + CURR_MES_TO;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE mes <= 202603");
  });

  it("replaces :comp_mes_from token", () => {
    const sql = "WHERE mes >= " + COMP_MES_FROM;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE mes >= 202501");
  });

  it("replaces :comp_mes_to token", () => {
    const sql = "WHERE mes <= " + COMP_MES_TO;
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe("WHERE mes <= 202503");
  });

  it("replaces all 8 tokens in one SQL string", () => {
    const sql = [
      "WHERE fecha BETWEEN " + CURR_FROM + " AND " + CURR_TO,
      "  AND mes BETWEEN " + CURR_MES_FROM + " AND " + CURR_MES_TO,
      "UNION ALL",
      "WHERE fecha BETWEEN " + COMP_FROM + " AND " + COMP_TO,
      "  AND mes BETWEEN " + COMP_MES_FROM + " AND " + COMP_MES_TO,
    ].join(" ");
    const result = substituteDateParams(sql, RANGES_WITH_COMP);
    expect(result).toContain("'2026-01-01'");
    expect(result).toContain("'2026-03-31'");
    expect(result).toContain("202601");
    expect(result).toContain("202603");
    expect(result).toContain("'2025-01-01'");
    expect(result).toContain("'2025-03-31'");
    expect(result).toContain("202501");
    expect(result).toContain("202503");
    expect(result).not.toContain(":curr_");
    expect(result).not.toContain(":comp_");
  });

  it("is a no-op on plain SQL with no tokens", () => {
    const sql = "SELECT SUM(total_si) FROM ps_ventas";
    expect(substituteDateParams(sql, RANGES_WITH_COMP)).toBe(sql);
  });

  it("leaves COMP_* tokens unchanged when comp range is undefined", () => {
    const sql = "WHERE fecha >= " + CURR_FROM + " AND comp_fecha >= " + COMP_FROM;
    const result = substituteDateParams(sql, RANGES_NO_COMP);
    expect(result).toContain("'2026-01-01'");
    expect(result).toContain(COMP_FROM);
  });

  it("toMesInt: Dec 2025 produces 202512 not 202600", () => {
    const decDate = new Date(Date.UTC(2025, 11, 1));
    const sql = "WHERE mes = " + CURR_MES_FROM;
    const result = substituteDateParams(sql, {
      curr: { from: decDate, to: decDate },
    });
    expect(result).toBe("WHERE mes = 202512");
  });

  it("toMesInt: Jan produces 01 suffix", () => {
    const janDate = new Date(Date.UTC(2025, 0, 15));
    const sql = "WHERE mes = " + CURR_MES_FROM;
    const result = substituteDateParams(sql, {
      curr: { from: janDate, to: janDate },
    });
    expect(result).toBe("WHERE mes = 202501");
  });

  it("toDateStr: pads month and day with leading zero", () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    const sql = "WHERE fecha = " + CURR_FROM;
    const result = substituteDateParams(sql, {
      curr: { from: d, to: d },
    });
    expect(result).toBe("WHERE fecha = '2026-01-05'");
  });

  it("replaces multiple occurrences of the same token", () => {
    const sql = "SELECT " + CURR_FROM + " AS a, " + CURR_FROM + " AS b";
    const result = substituteDateParams(sql, RANGES_NO_COMP);
    expect(result).toBe("SELECT '2026-01-01' AS a, '2026-01-01' AS b");
  });
});
