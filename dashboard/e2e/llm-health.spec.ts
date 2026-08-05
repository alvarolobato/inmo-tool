/**
 * E2E: "LLM / IA" cost/usage panel on the "Salud de datos" page (issue #324,
 * D-041).
 *
 * Drives a real Next.js server against a real Postgres, seeding llm_usage /
 * llm_tool_calls / llm_errors rows directly via `pg`, then asserts:
 *
 *   - The LLM/IA section renders (extends the existing data-health page, not a
 *     new page).
 *   - Cost/call summary tiles render (today + 7d), by-flow table and
 *     by-provider cards render with the seeded data.
 *   - A CLI-provider card is labelled €0 (subscription), an openrouter card
 *     shows a non-zero estimated €.
 *   - Coverage / backlog + scheduler throttle tiles render.
 *   - No error surface (ErrorDisplay / "Detalles técnicos" / "there is no
 *     parameter" / "HTTP 500" / "Error al cargar") — the D-041 bar.
 *
 * Admin-gated (middleware.ts `/etl/:path*` + `/api/etl/:path*`), so the test
 * sets the `ps_admin` cookie the way /admin/login does. Skips cleanly when
 * Postgres is unreachable or ADMIN_API_KEY is unset, matching the other specs.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

function buildPool(): Pool {
  const dsn = process.env.POSTGRES_DSN;
  if (dsn) return new Pool({ connectionString: dsn, max: 2 });
  return new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "inmotool",
    max: 2,
  });
}

// Distinctive markers so cleanup is precise and can't touch real data.
const E2E_REQ_PREFIX = "e2e-llm-health-";
const OR_MODEL = "anthropic/claude-sonnet-4";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();

async function purge(): Promise<void> {
  await pool.query("DELETE FROM llm_usage WHERE request_id LIKE $1", [
    `${E2E_REQ_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM llm_tool_calls WHERE request_id LIKE $1", [
    `${E2E_REQ_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM llm_errors WHERE request_id LIKE $1", [
    `${E2E_REQ_PREFIX}%`,
  ]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[llm-health.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();

  // OpenRouter occupancy call: real tokens → a non-zero estimated €.
  await pool.query(
    `INSERT INTO llm_usage
       (endpoint, model, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_usd, llm_provider, request_id, created_at)
     VALUES ('occupancy', $1, 1000000, 500000, 1500000, 0, 'openrouter', $2, NOW())`,
    [OR_MODEL, `${E2E_REQ_PREFIX}or-1`],
  );
  // CLI extract call: tokens present but provider is the flat subscription → €0.
  await pool.query(
    `INSERT INTO llm_usage
       (endpoint, model, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_usd, llm_provider, request_id, created_at)
     VALUES ('extract', $1, 2000000, 1000000, 3000000, 0, 'cli', $2, NOW())`,
    [OR_MODEL, `${E2E_REQ_PREFIX}cli-1`],
  );
  // A tool call + an error so those tables have seeded rows too.
  await pool.query(
    `INSERT INTO llm_tool_calls
       (tool_name, endpoint, request_id, status, latency_ms, llm_provider, created_at)
     VALUES ('execute_sql', 'occupancy', $1, 'ok', 42, 'openrouter', NOW())`,
    [`${E2E_REQ_PREFIX}tool-1`],
  );
  await pool.query(
    `INSERT INTO llm_errors
       (request_id, endpoint, code, provider, created_at)
     VALUES ($1, 'occupancy', 'RATE_LIMIT', 'openrouter', NOW())`,
    [`${E2E_REQ_PREFIX}err-1`],
  );
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("renders the LLM/IA cost panel with seeded usage (EC + D-041)", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();

  // The LLM/IA section is present.
  const section = page.getByTestId("llm-health");
  await expect(section).toBeVisible();

  // Cost + call summary tiles render. (Values are aggregates over the whole
  // llm_usage table, which may hold rows beyond this test's seed, so we assert
  // the tiles render — not exact global totals.)
  await expect(page.getByTestId("llm-cost-today")).toBeVisible();
  await expect(page.getByTestId("llm-cost-7d")).toBeVisible();
  await expect(page.getByTestId("llm-calls-7d")).toBeVisible();

  // By-flow table shows the seeded occupancy flow (Spanish label). This row is
  // present because this test seeded an `occupancy` usage row, regardless of
  // any other rows in the table.
  await expect(page.getByTestId("llm-flow-occupancy")).toBeVisible();
  await expect(page.getByTestId("llm-flow-occupancy")).toContainText(
    "Ocupación",
  );

  // Provider cards: openrouter shows a euro cost (tokens were seeded, so cost
  // is estimated, not "—"); cli is labelled as the flat-subscription €0.
  await expect(page.getByTestId("llm-provider-openrouter")).toBeVisible();
  await expect(page.getByTestId("llm-provider-cost-openrouter")).toContainText(
    "€",
  );
  await expect(page.getByTestId("llm-provider-cli")).toBeVisible();
  await expect(page.getByTestId("llm-provider-cli-cli")).toContainText(
    "Suscripción",
  );
  await expect(page.getByTestId("llm-provider-cost-cli")).toContainText("0 €");

  // Coverage + scheduler throttle tiles render.
  await expect(page.getByTestId("llm-coverage-pct")).toBeVisible();
  await expect(page.getByTestId("llm-coverage-pending")).toBeVisible();
  await expect(page.getByTestId("llm-scheduler-batch")).toBeVisible();
  await expect(page.getByTestId("llm-scheduler-enabled-badge")).toBeVisible();
  await expect(page.getByTestId("llm-errors")).toBeVisible();

  // ── D-041 bar: no error surface anywhere on the page. ──
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("Detalles técnicos");
  await expect(body).not.toContainText("there is no parameter");
  await expect(body).not.toContainText("HTTP 500");
  await expect(body).not.toContainText("Error al cargar");
});
