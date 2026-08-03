// `dashboard/lib/knowledge.ts` is live, generated machinery (see
// `dashboard/scripts/build-knowledge.ts` and `docs/knowledge-sources.yml`) —
// not dead code. It is imported by `lib/llm-context/system-prompt.ts` (the
// chat flow's schema context) and `lib/llm-context/formatters.ts`. It is
// currently EMPTY on purpose: task 1.1 (#9) deleted the PowerShop retail
// corpus this file used to assert, and no real-estate replacement has been
// authored yet — that's Phase 4 (#5), not this fix. `buildSchemaContext()`
// in system-prompt.ts already degrades gracefully when these arrays are
// empty (falls back to "discover the schema with list_tables/describe_table"
// rather than emitting an empty heading), so an empty corpus is a valid,
// exercised state, not a bug.
//
// These tests were rewritten (see issue #158) to assert two things instead
// of the old PowerShop-domain content (`ps_ventas` join paths, "tienda 99",
// etc., none of which exist in this product):
//   1. A generic shape contract every entry must satisfy, *if* one exists —
//      this holds vacuously today and starts enforcing for real the moment
//      Phase 4 adds content, without needing another rewrite.
//   2. One explicit test documenting today's empty state, so a regression
//      (an entry silently deleted from a populated corpus) is still caught,
//      and so the intentional current state is visible rather than implicit.
//      Update *only* that second test's expectations when Phase 4 lands —
//      resist the urge to also loosen the shape contract.
import { describe, it, expect } from "vitest";
import {
  INSTRUCTIONS,
  SQL_PAIRS,
  SCHEMA,
  RELATIONSHIPS,
} from "../knowledge";

describe("knowledge", () => {
  describe("shape contract (applies to any future entries)", () => {
    it("every INSTRUCTIONS entry has non-empty instruction text and questions", () => {
      for (const inst of INSTRUCTIONS) {
        expect(inst.instruction.length).toBeGreaterThan(10);
        expect(inst.questions.length).toBeGreaterThan(0);
        for (const q of inst.questions) {
          expect(q.length).toBeGreaterThan(0);
        }
      }
    });

    it("every SQL_PAIRS entry has a question and SELECT/FROM SQL", () => {
      for (const pair of SQL_PAIRS) {
        expect(pair.question.length).toBeGreaterThan(5);
        expect(pair.sql).toMatch(/SELECT/i);
        expect(pair.sql).toMatch(/FROM/i);
      }
    });

    it("no SQL_PAIRS entry uses CURRENT_DATE or a bare INTERVAL", () => {
      // These read as "now" at generation time rather than at query time in
      // some execution contexts; source pairs should use explicit bind
      // parameters instead. Generic invariant, not PowerShop-specific.
      for (const pair of SQL_PAIRS) {
        expect(pair.sql).not.toMatch(/CURRENT_DATE/);
        expect(pair.sql).not.toMatch(/\bINTERVAL\b/);
      }
    });

    it("every SCHEMA entry has an alias and at least one key column", () => {
      for (const table of SCHEMA) {
        expect(table.alias.length).toBeGreaterThan(0);
        expect(table.keyColumns.length).toBeGreaterThan(0);
      }
    });

    it("every RELATIONSHIPS entry is MANY_TO_ONE", () => {
      for (const rel of RELATIONSHIPS) {
        expect(rel.type).toBe("MANY_TO_ONE");
      }
    });
  });

  describe("current corpus state", () => {
    it("is empty pending Phase 4 real-estate corpus authoring (#5) — update when that lands", () => {
      expect(INSTRUCTIONS).toEqual([]);
      expect(SQL_PAIRS).toEqual([]);
      expect(SCHEMA).toEqual([]);
      expect(RELATIONSHIPS).toEqual([]);
    });
  });
});
