import { describe, it, expect } from "vitest";
import { buildSpec } from "@/lib/review-dashboard-seed";
import { REVIEW_DASHBOARD_KEYS } from "@/lib/review-schema";

/**
 * Regression guard for the "there is no parameter $1" production bug.
 *
 * REVIEW_QUERIES use positional params ($1/$2) that the weekly-review API
 * binds. When the same SQL is embedded into a SAVED dashboard, it is executed
 * by DashboardRenderer, which only substitutes :curr_from/:curr_to date tokens
 * and passes NO positional params — so any leftover `$1` reaches Postgres
 * unbound and fails. This invariant (embedded widget SQL must be renderable:
 * date tokens only, never positional params) was previously untested: the
 * review queries were only exercised in the review flow where the params ARE
 * bound, and the seed itself had no test.
 */
describe("review dashboard seed — embedded SQL is renderable", () => {
  for (const key of REVIEW_DASHBOARD_KEYS) {
    it(`buildSpec(${key}) embeds no unbound positional params`, () => {
      const spec = buildSpec(key);
      for (const widget of spec.widgets) {
        const sql = (widget as { sql?: string }).sql ?? "";
        // No $1, $2, … — DashboardRenderer never binds positional params.
        expect(sql).not.toMatch(/\$\d/);
      }
    });
  }

  it("maps the closed-week range to :curr_from / :curr_to date tokens", () => {
    const spec = buildSpec("compras");
    const sql = (spec.widgets[0] as { sql: string }).sql;
    expect(sql).toContain(":curr_from");
    expect(sql).toContain(":curr_to");
  });
});
