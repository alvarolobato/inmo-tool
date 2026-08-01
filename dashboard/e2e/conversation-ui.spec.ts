/**
 * Playwright e2e tests for conversation UI fixes (issue #705).
 *
 * EC-1: Autosend on new conversation — message sent without re-typing
 * EC-3: Suggestion pill click sends immediately — no extra click needed
 *
 * Pre-requisites:
 *   - App running at http://localhost:4000 (or DASHBOARD_PORT env var)
 *   - A seeded dashboard accessible via /api/dashboard (at least one record)
 */

import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.DASHBOARD_PORT
  ? `http://localhost:${process.env.DASHBOARD_PORT}`
  : "http://localhost:4000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrCreateDashboardId(page: Page): Promise<string> {
  const res = await page.request.get(`${BASE}/api/dashboard`);
  if (res.ok()) {
    const body = (await res.json()) as
      | { id: number }[]
      | { dashboards: { id: number }[] };
    const list = Array.isArray(body) ? body : (body as { dashboards: { id: number }[] }).dashboards;
    if (list && list.length > 0) return String(list[0].id);
  }
  // Create a minimal dashboard for testing
  const create = await page.request.post(`${BASE}/api/dashboard`, {
    data: {
      name: "E2E Test Dashboard",
      spec: {
        title: "E2E Test Dashboard",
        widgets: [
          { id: "w1", type: "bar_chart", title: "Test", sql: "SELECT 1 AS x, 1 AS y", x: "x", y: "y" },
        ],
      },
    },
  });
  const created = await create.json();
  return String((created as { id: number }).id);
}

// ---------------------------------------------------------------------------
// EC-1: Autosend on new conversation
// ---------------------------------------------------------------------------

test("autosends on new conversation", async ({ page }) => {
  const prompt = "¿Cuántas ventas hubo ayer?";

  // Create a conversation with first_user_prompt so the server has it
  const createRes = await page.request.post(`${BASE}/api/conversations`, {
    data: { mode: "chat", context_kind: "global" },
  });
  expect(createRes.ok()).toBeTruthy();
  const { id } = (await createRes.json()) as { id: string };

  // Set the sessionStorage key that NewConversationDialog would have written
  await page.goto(`${BASE}/conversations/${id}`);
  await page.evaluate(
    ({ convId, p }) => {
      sessionStorage.setItem(`conv-autosend-${convId}`, p);
    },
    { convId: id, p: prompt },
  );

  // Reload — ConversationPane mounts and reads the sessionStorage key
  await page.reload();

  // The user bubble should appear (autosend fired without manual input)
  await expect(page.getByTestId("user-bubble").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("user-bubble").first()).toContainText(prompt);

  // The loading indicator or assistant response appears — session key was consumed
  const sentWithoutTyping = await page.evaluate(
    ({ convId }) => sessionStorage.getItem(`conv-autosend-${convId}`) === null,
    { convId: id },
  );
  expect(sentWithoutTyping).toBe(true);
});

// ---------------------------------------------------------------------------
// EC-3: Suggestion pill click sends immediately
// ---------------------------------------------------------------------------

test("suggestion pill click sends message immediately", async ({ page }) => {
  const dashId = await getOrCreateDashboardId(page);
  await page.goto(`${BASE}/paneles/${dashId}`);

  // Open analyze sidebar via the AnalyzeLauncher rail
  const launcher = page.getByTestId("analyze-launcher");
  await expect(launcher).toBeVisible({ timeout: 8_000 });
  await launcher.click();

  // Sidebar should open in "Analizar" tab with suggestion pills visible
  await expect(page.getByTestId("chat-sidebar")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("suggestion-pills")).toBeVisible({ timeout: 5_000 });

  // Input should be empty (no pre-filled prompt)
  const textarea = page.getByPlaceholder("Escribe un mensaje…");
  await expect(textarea).toHaveValue("");

  // Click the first suggestion pill
  const firstPill = page.getByTestId("suggestion-pill").first();
  const pillText = await firstPill.innerText();
  await firstPill.click();

  // User bubble appears with the pill text — no extra send click needed
  await expect(page.getByTestId("user-bubble").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("user-bubble").first()).toContainText(
    pillText.slice(0, 20),
  );

  // Pills disappear once a message is sent
  await expect(page.getByTestId("suggestion-pills")).not.toBeVisible({
    timeout: 5_000,
  });
});
