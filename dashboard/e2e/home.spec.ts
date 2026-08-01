/**
 * e2e: home page (`/`) renders without error surfaces against seeded Postgres.
 *
 * Spec motivation: unit tests mock Postgres and cannot catch SQL runtime errors.
 * This spec loads real seed data and asserts the home renders real content —
 * catching errors like `there is no parameter $1` before they reach production.
 *
 * Requires:
 *   - `init-test-db.sh` called before this suite (done in beforeAll below, or externally).
 *   - App started with `DASHBOARD_LLM_PROVIDER=e2e-stub`.
 *
 * See: docs/skills/e2e-testing.md, D-041, dashboard/e2e/fixtures/README.md
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildE2eDsn(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  if (process.env.POSTGRES_DSN) return process.env.POSTGRES_DSN;
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const user = process.env.POSTGRES_USER ?? "postgres";
  const pass = process.env.POSTGRES_PASSWORD ?? "postgres";
  const db = process.env.POSTGRES_DB ?? "powershop_e2e";
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  const dsn = buildE2eDsn();
  const scriptPath = path.resolve(__dirname, "fixtures/init-test-db.sh");
  execSync(`${scriptPath} "${dsn}"`, { stdio: "inherit" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("home page renders without error surfaces", async ({ page }) => {
  await page.goto("/");

  // Wait for the hero section to appear (signals the page loaded)
  await page.waitForSelector('[data-testid="hero-today"]', { timeout: 30_000 });

  // No error surfaces should be visible
  await expect(page.locator('[data-testid="error-display"]')).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("home page hero-today renders real values (not skeleton)", async ({ page }) => {
  await page.goto("/");

  const hero = page.locator('[data-testid="hero-today"]');
  await expect(hero).toBeVisible({ timeout: 30_000 });

  // Assert the value node directly — hero.innerText() would include label text
  // ("Ventas hoy", "EN VIVO", etc.) and produce false positives
  const heroValue = page.locator('[data-testid="hero-value"]');
  await expect(heroValue).toBeVisible();
  const valueText = await heroValue.innerText();
  expect(valueText).toMatch(/[0-9€]/);
});

test("home page period-grid renders real content", async ({ page }) => {
  await page.goto("/");

  // The home renders two period grids (Comparativa por periodo + Margen bruto),
  // so the locator matches >1 element — assert the first is visible (strict mode
  // would otherwise fail on the multi-match).
  const grid = page.locator('[data-testid="period-grid"]').first();
  await expect(grid).toBeVisible({ timeout: 30_000 });

  // At least one period card must be visible — section header alone doesn't
  // prove data-backed cards rendered
  await expect(page.locator('[data-testid^="period-card-"]').first()).toBeVisible({
    timeout: 15_000,
  });
});
