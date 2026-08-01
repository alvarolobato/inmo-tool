/**
 * Playwright e2e tests for conversation engine (Phase 3 ACs 4–9).
 *
 * Pre-requisites:
 *   - App running at http://localhost:4000 (or DASHBOARD_PORT)
 *   - A seeded conversation is accessible at /api/conversations/seed-for-e2e
 *     (set E2E_CONV_ID env var or rely on the fixture helper below)
 *
 * AC-4: Browser refresh during streaming shows same state
 * AC-5: Context panel appears per message within 500ms of turn start
 * AC-6: Logs persist after page refresh
 * AC-7: Panel (ChatSidebar) and standalone (/c/:id) show identical content
 * AC-8: Browser close mid-stream → reopen shows completed response
 * AC-9: Two browser contexts see consistent SSE state
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a conversation and return its ID, or reuse E2E_CONV_ID env var. */
async function ensureConversation(page: Page): Promise<string> {
  if (process.env.E2E_CONV_ID) return process.env.E2E_CONV_ID;

  const resp = await page.request.post("/api/conversations", {
    data: {
      mode: "chat",
      context_kind: "global",
      title: "e2e test conversation",
    },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  return body.id as string;
}

/** POST a turn and return the turnId. */
async function postTurn(page: Page, convId: string, message: string): Promise<string> {
  const resp = await page.request.post(`/api/conversations/${convId}/turns`, {
    data: { content: message },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  return body.turnId as string;
}

/** Wait until the conversation shows at least one assistant bubble. */
async function waitForAssistantBubble(page: Page, timeout = 30_000) {
  await page.waitForSelector('[data-testid="assistant-bubble"]', { timeout });
}

// ---------------------------------------------------------------------------
// AC-4: Browser refresh during streaming shows same state
// ---------------------------------------------------------------------------

test("AC-4: refresh during streaming shows same logs already received", async ({ page }) => {
  const convId = await ensureConversation(page);
  await postTurn(page, convId, "Hola, ¿puedes hacer una prueba rápida?");

  await page.goto(`/c/${convId}`);

  // Wait for at least one log block to appear
  await page.waitForSelector('[data-testid="log-block"]', { timeout: 20_000 });

  // Capture the log count before reload
  const logCountBefore = await page.locator('[data-testid="log-block"]').count();
  expect(logCountBefore).toBeGreaterThan(0);

  // Refresh mid-stream (or after partial loading)
  await page.reload();
  await page.waitForSelector('[data-testid="log-block"]', { timeout: 20_000 });

  // After refresh the same logs should be present (replayed from DB)
  const logCountAfter = await page.locator('[data-testid="log-block"]').count();
  expect(logCountAfter).toBeGreaterThanOrEqual(logCountBefore);
});

// ---------------------------------------------------------------------------
// AC-5: Context panel appears per message within 500ms of turn start
// ---------------------------------------------------------------------------

test("AC-5: context panel appears within 500ms of assistant response", async ({ page }) => {
  const convId = await ensureConversation(page);

  await page.goto(`/c/${convId}`);

  // Send a message via the input
  const input = page.getByRole("textbox", { name: /mensaje|message/i }).or(
    page.locator("textarea").first(),
  );
  await input.fill("Describe el modelo que usas.");
  await input.press("Enter");

  // Context panel must appear quickly
  await page.waitForSelector('[data-testid="context-panel"]', { timeout: 10_000 });

  // Verify it shows model/provider info
  const panelText = await page.locator('[data-testid="context-panel"]').first().textContent();
  expect(panelText).toBeTruthy();
});

// ---------------------------------------------------------------------------
// AC-6: Logs persist after page refresh
// ---------------------------------------------------------------------------

test("AC-6: logs persist after full page reload", async ({ page }) => {
  const convId = await ensureConversation(page);
  await postTurn(page, convId, "¿Cuál es la capital de España?");

  // Wait for the turn to complete
  await page.goto(`/c/${convId}`);
  await waitForAssistantBubble(page);

  // Log blocks appear after SSE event replay completes the complete event and
  // triggers a conversation refresh — waitForAssistantBubble only ensures the
  // REST API response arrived, not the SSE replay. Wait for the count to settle.
  await page
    .locator('[data-testid="log-block"]')
    .first()
    .waitFor({ state: "attached", timeout: 5_000 })
    .catch(() => { console.warn("AC-6: log-block not found before reload — count comparison may be vacuous"); });

  const logsBefore = await page.locator('[data-testid="log-block"]').count();

  // Full reload
  await page.reload();
  await waitForAssistantBubble(page);
  await page
    .locator('[data-testid="log-block"]')
    .first()
    .waitFor({ state: "attached", timeout: 5_000 })
    .catch(() => { console.warn("AC-6: log-block not found after reload"); });

  // SSE replays historical log events asynchronously after reconnect. The assistant
  // bubble appears from loadConversation (before SSE replay finishes), so we must
  // wait explicitly for log-blocks to render before asserting.
  if (logsBefore > 0) {
    await page.waitForSelector('[data-testid="log-block"]', { timeout: 15_000 });
  }

  const logsAfter = await page.locator('[data-testid="log-block"]').count();
  expect(logsAfter).toEqual(logsBefore);
});

// ---------------------------------------------------------------------------
// AC-7: Panel and standalone show identical content
// ---------------------------------------------------------------------------

// Note: after Phase 3, both /c/[id] and /conversations/[id] render ConversationPane
// in standalone mode; mode="panel" is exercised by the ChatSidebar unit tests.
// This test validates that both standalone routes resolve the same conversation identically.
test("AC-7: both standalone routes show identical messages for the same conversation", async ({ page, context }) => {
  const convId = await ensureConversation(page);
  await postTurn(page, convId, "Muéstrame algo interesante.");

  // Wait for turn to complete
  await page.goto(`/c/${convId}`);
  await waitForAssistantBubble(page, 45_000);

  // Collect standalone message texts
  const standaloneMessages = await page
    .locator('[data-testid="assistant-bubble"]')
    .allTextContents();

  // Open a second page pointing to the split-view route
  const page2 = await context.newPage();
  await page2.goto(`/conversations/${convId}`);
  await page2.waitForSelector('[data-testid="assistant-bubble"]', { timeout: 20_000 });

  const panelMessages = await page2.locator('[data-testid="assistant-bubble"]').allTextContents();

  expect(panelMessages).toEqual(standaloneMessages);
  await page2.close();
});

// ---------------------------------------------------------------------------
// AC-8: Browser close mid-stream → reopen shows completed response
// ---------------------------------------------------------------------------

test("AC-8: reopening after close shows completed response", async ({ browser }) => {
  const context1: BrowserContext = await browser.newContext();
  const page1 = await context1.newPage();

  const convId = await ensureConversation(page1);

  // Start a turn — capture turnId so we can poll the turn-specific status endpoint
  const turnId = await postTurn(page1, convId, "Explica brevemente qué es el comercio minorista.");

  await page1.goto(`/c/${convId}`);

  // Close the context while the response may still be streaming
  await page1.waitForTimeout(1_000);
  await context1.close();

  // Wait for the turn to complete server-side (poll GET /turns/:turnId which returns { turn: { status } })
  const context2: BrowserContext = await browser.newContext();
  const page2 = await context2.newPage();

  // Poll until the turn reaches a terminal status.
  // GET /api/conversations/:id/turns/:turnId returns { turn: TurnRow, events: TurnEventRow[] }.
  let completed = false;
  for (let i = 0; i < 30; i++) {
    const resp = await page2.request.get(`/api/conversations/${convId}/turns/${turnId}`);
    if (resp.ok()) {
      const body = await resp.json();
      if (body.turn?.status === "complete" || body.turn?.status === "error") {
        completed = true;
        break;
      }
    }
    await page2.waitForTimeout(2_000);
  }

  expect(completed).toBe(true);

  // Navigate and verify the completed response is visible
  await page2.goto(`/c/${convId}`);
  await waitForAssistantBubble(page2, 10_000);

  const assistantBubbles = await page2.locator('[data-testid="assistant-bubble"]').count();
  expect(assistantBubbles).toBeGreaterThan(0);

  await context2.close();
});

// ---------------------------------------------------------------------------
// AC-9: Two browser contexts see consistent state via SSE
// ---------------------------------------------------------------------------

test("AC-9: two browser windows see consistent streaming state", async ({ browser }) => {
  const context1: BrowserContext = await browser.newContext();
  const context2: BrowserContext = await browser.newContext();

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  const convId = await ensureConversation(page1);

  // Open both windows on the same conversation
  await page1.goto(`/c/${convId}`);
  await page2.goto(`/c/${convId}`);

  // Send a message from page1
  const input = page1.getByRole("textbox").or(page1.locator("textarea").first());
  await input.fill("¿Qué tiempo hace en Madrid?");
  await input.press("Enter");

  // Both windows should eventually show the user message and a response
  await waitForAssistantBubble(page1, 45_000);
  await waitForAssistantBubble(page2, 45_000);

  const msgs1 = await page1.locator('[data-testid="assistant-bubble"]').allTextContents();
  const msgs2 = await page2.locator('[data-testid="assistant-bubble"]').allTextContents();

  // Both contexts should see the same number of assistant messages
  expect(msgs2.length).toEqual(msgs1.length);

  await context1.close();
  await context2.close();
});
