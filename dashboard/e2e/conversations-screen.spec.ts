/**
 * e2e: /conversations list and detail — row, title, messages, cross-link.
 *
 * Covers EC-4 (title in list), EC-5 (list + detail), EC-6 (cross-link to source dashboard).
 *
 * Setup: creates a real conversation via the API (Modificar mode, dashboard context)
 * then posts a turn so messages exist. All under DASHBOARD_LLM_PROVIDER=e2e-stub.
 *
 * See: docs/skills/e2e-testing.md, D-041, EC-4, EC-5, EC-6
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// Setup helpers
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

let dashboardId: number;
let convId: string;
const TEST_MESSAGE = "Mensaje e2e para conversaciones-screen";

test.beforeAll(async ({ request }) => {
  // Seed ps_* data
  const initScript = path.resolve(__dirname, "fixtures/init-test-db.sh");
  const dsn = buildE2eDsn();
  execSync(`${initScript} "${dsn}"`, { stdio: "inherit" });

  // Seed dashboards and capture first ID
  const seedScript = path.resolve(__dirname, "seed-dashboards.ts");
  const dashboardRoot = path.resolve(__dirname, "..");
  const out = execSync(`npx tsx ${seedScript}`, {
    cwd: dashboardRoot,
    env: { ...process.env, POSTGRES_DSN: dsn },
  }).toString();

  const ids = [...out.matchAll(/→ id (\d+)/g)].map((m) => Number(m[1]));
  if (ids.length === 0) throw new Error("seed-dashboards produced no dashboard IDs");
  dashboardId = ids[0];

  // Create a conversation with dashboard context (modify mode)
  const convResp = await request.post("/api/conversations", {
    data: {
      mode: "modify",
      context_kind: "dashboard",
      context_ref: String(dashboardId),
      first_user_prompt: TEST_MESSAGE,
    },
  });
  expect(convResp.ok()).toBeTruthy();
  const convBody = await convResp.json();
  convId = (convBody as { id: string }).id;
  expect(convId).toBeTruthy();

  // Post a turn so the conversation has messages
  const turnResp = await request.post(`/api/conversations/${convId}/turns`, {
    data: { content: TEST_MESSAGE },
  });
  expect(turnResp.ok()).toBeTruthy();

  // Wait for the turn to complete (poll up to 30s)
  const turnBody = await turnResp.json();
  const turnId = (turnBody as { turnId: string }).turnId;
  let finalStatus: string | undefined;
  for (let i = 0; i < 15; i++) {
    const poll = await request.get(`/api/conversations/${convId}/turns/${turnId}`);
    if (poll.ok()) {
      const pollBody = await poll.json();
      const status = (pollBody as { turn?: { status?: string } }).turn?.status;
      if (status === "complete" || status === "error") {
        finalStatus = status;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  expect(finalStatus).toBe("complete");
});

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

async function assertNoErrors(page: Page) {
  await expect(page.locator('[data-testid="error-display"]')).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// EC-4 + EC-5: Conversations list — row with title; detail with messages
// ---------------------------------------------------------------------------

test("EC-4 + EC-5: conversation row visible with title; detail shows stored messages", async ({
  page,
}) => {
  await page.goto("/conversations");

  // Wait for the table to load — the row for our seeded conversation must appear.
  // Use first_user_prompt as the display title since set_title isn't called by the stub.
  const convRow = page.locator(`[data-testid="conversation-row-${convId}"]`);
  await expect(convRow).toBeVisible({ timeout: 20_000 });

  // Title cell must contain the first_user_prompt set at creation
  const titleCell = page.locator(`[data-testid="title-cell-${convId}"]`);
  await expect(titleCell).toBeVisible({ timeout: 5_000 });
  await expect(titleCell).toContainText(TEST_MESSAGE);

  // No error surfaces on the list page
  await assertNoErrors(page);

  // Click the title cell link → navigate to /conversations/{convId}
  await titleCell.click();
  await page.waitForURL(`**/conversations/${convId}`, { timeout: 10_000 });

  // Detail view: stored user message is visible
  await expect(
    page.locator('[data-testid="user-bubble"]').filter({ hasText: TEST_MESSAGE }),
  ).toBeVisible({ timeout: 20_000 });

  // Assistant reply from stub
  await expect(
    page.locator('[data-testid="assistant-bubble"]').filter({ hasText: "[e2e-stub]" }),
  ).toBeVisible({ timeout: 10_000 });

  // No error surfaces on the detail page
  await assertNoErrors(page);
});

// ---------------------------------------------------------------------------
// EC-6: Cross-link — context link navigates to source dashboard
// ---------------------------------------------------------------------------

test("EC-6: context link in conversations list navigates to the source dashboard", async ({
  page,
}) => {
  await page.goto("/conversations");

  // Wait for the conversation row
  const convRow = page.locator(`[data-testid="conversation-row-${convId}"]`);
  await expect(convRow).toBeVisible({ timeout: 20_000 });

  // The context cell for a dashboard conversation shows the dashboard name as a link
  const contextLink = page.locator(`[data-testid="context-link-${convId}"]`);
  await expect(contextLink).toBeVisible({ timeout: 5_000 });

  // Verify href points to /dashboard/{dashboardId}
  const href = await contextLink.getAttribute("href");
  expect(href).toBe(`/dashboard/${dashboardId}`);

  // Click and assert navigation to the dashboard page
  await contextLink.click();
  await page.waitForURL(`**/dashboard/${dashboardId}`, { timeout: 10_000 });

  // The dashboard page should load without error
  await assertNoErrors(page);
});
