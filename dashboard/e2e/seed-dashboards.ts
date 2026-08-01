/**
 * Dashboard seeder for e2e tests.
 *
 * Creates the saved dashboards (review dashboards + a standard template
 * dashboard) so that `dashboards.spec.ts` can navigate to them and assert
 * they render without errors. Uses the same seeder functions the app uses —
 * no spec JSON pasted here.
 *
 * Usage (from repo root, with the dashboard package installed):
 *   cd dashboard && npx tsx e2e/seed-dashboards.ts
 *
 * Environment: reads POSTGRES_DSN or POSTGRES_HOST/PORT/USER/PASSWORD/DB,
 * same as the app itself.
 */

import { getOrCreateReviewDashboardId } from "../lib/review-dashboard-seed";
import { REVIEW_DASHBOARD_KEYS } from "../lib/review-schema";
import { sql } from "../lib/db-write";
import { TEMPLATES } from "../lib/templates";

async function main() {
  // 1. Seed review dashboards (ventas_retail, canal_mayorista, stock, compras)
  for (const key of REVIEW_DASHBOARD_KEYS) {
    const id = await getOrCreateReviewDashboardId(key);
    console.log(`review dashboard [${key}] → id ${id}`);
  }

  // 2. Seed one standard template dashboard ("ventas") so dashboards.spec.ts
  //    has a non-review dashboard to exercise.
  const tmpl = TEMPLATES.find((t) => t.slug === "ventas");
  if (!tmpl) throw new Error("Template 'ventas' not found");

  const existing = await sql<{ id: number }>(
    `SELECT id FROM dashboards WHERE name = $1 LIMIT 1`,
    [tmpl.name],
  );
  if (existing.length > 0) {
    await sql(
      `UPDATE dashboards SET description = $1, spec = $2::jsonb WHERE id = $3`,
      [tmpl.description, JSON.stringify(tmpl.spec), existing[0].id],
    );
    console.log(`template dashboard [${tmpl.slug}] → id ${existing[0].id} (updated)`);
  } else {
    const created = await sql<{ id: number }>(
      `INSERT INTO dashboards (name, description, spec) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [tmpl.name, tmpl.description, JSON.stringify(tmpl.spec)],
    );
    console.log(`template dashboard [${tmpl.slug}] → id ${created[0].id} (created)`);
  }

  console.log("✓ e2e dashboard seed complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-dashboards failed:", err);
  process.exit(1);
});
