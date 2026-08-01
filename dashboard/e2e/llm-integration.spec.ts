/**
 * e2e: LLM integration — the FULL conversation/LLM pipeline against a scripted model.
 *
 * Runs under DASHBOARD_LLM_PROVIDER=mock (NOT e2e-stub). Where e2e-stub short-
 * circuits turn-background.ts before any LLM code runs and returns a canned
 * string, `mock` flows through the real pipeline: assembleRequest →
 * buildSystemPrompt → runAgenticChat → real tool dispatch (SQL against the
 * seeded Postgres) → spec validation → versioned persistence. The scripted
 * adapter (dashboard/lib/llm-provider/mock/script.ts) is the only thing
 * replaced — so these tests prove the integration actually works end-to-end.
 *
 * Requires the dev server started with DASHBOARD_LLM_PROVIDER=mock and the
 * seeded fixture loaded (see fixtures/init-test-db.sh). CI wiring is proposed
 * in the PR body per D-029 (the worker cannot edit .github/workflows/).
 */

import { test, expect, type Page } from "@playwright/test";

test.beforeAll(() => {
  // Guard: this suite is meaningless against the canned stub.
  if (process.env.DASHBOARD_LLM_PROVIDER !== "mock") {
    throw new Error(
      "llm-integration.spec.ts requires DASHBOARD_LLM_PROVIDER=mock (got " +
        `'${process.env.DASHBOARD_LLM_PROVIDER ?? "unset"}'). The dev server must ` +
        "be launched with that env so the scripted adapter is active.",
    );
  }
});

async function createConversation(
  page: Page,
  body: Record<string, unknown>,
): Promise<string> {
  const resp = await page.request.post("/api/conversations", { data: body });
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()).id as string;
}

async function postTurnAndWait(page: Page, convId: string, content: string): Promise<void> {
  const resp = await page.request.post(`/api/conversations/${convId}/turns`, {
    data: { content },
  });
  expect(resp.ok()).toBeTruthy();
  const { turnId } = await resp.json();

  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/conversations/${convId}/turns/${turnId}`);
        if (!r.ok()) return "pending";
        return (await r.json()).turn?.status ?? "pending";
      },
      { timeout: 30_000, message: "turn never reached a terminal status" },
    )
    .toMatch(/complete|error/);
}

async function createDashboard(page: Page): Promise<number> {
  const resp = await page.request.post("/api/dashboards", {
    data: {
      name: "Panel base (e2e mock)",
      description: "estado inicial",
      spec: {
        title: "Panel base",
        widgets: [
          {
            type: "kpi_row",
            items: [{ label: "Inicial", sql: "SELECT 1 AS value", format: "number" }],
          },
        ],
      },
    },
  });
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()).id as number;
}

// ---------------------------------------------------------------------------
// Free-chat: real agentic loop + real tool execution against seeded Postgres
// ---------------------------------------------------------------------------

test("free-chat runs the agentic tool loop and answers from real query results", async ({
  page,
}) => {
  const convId = await createConversation(page, {
    mode: "chat",
    context_kind: "global",
    title: "mock llm chat",
  });

  await page.goto(`/c/${convId}`);
  const input = page.locator('[data-testid="message-input"]');
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.fill("¿Cuántas ventas hay registradas?");
  await input.press("Enter");

  // A tool log proves execute_query actually ran (the agentic loop executed a
  // real SQL round, not a canned reply).
  await expect(page.locator('[data-testid="log-block"]').first()).toBeVisible({
    timeout: 30_000,
  });

  // The answer embeds the count read back from the seeded DB — full chain:
  // prompt → model → tool → Postgres → tool result → final answer.
  await expect(
    page.locator('[data-testid="assistant-bubble"]').filter({ hasText: "ventas registradas" }),
  ).toBeVisible({ timeout: 30_000 });
  const answer = await page
    .locator('[data-testid="assistant-bubble"]')
    .filter({ hasText: "ventas registradas" })
    .first()
    .textContent();
  expect(answer).toMatch(/\d+/); // a real number from the database
});

// ---------------------------------------------------------------------------
// Modify: apply_dashboard_modification → versioned persistence (#822 path)
// ---------------------------------------------------------------------------

test("modify persists the new spec AND snapshots the previous one as a version", async ({
  page,
}) => {
  const dashId = await createDashboard(page);

  const convId = await createConversation(page, {
    mode: "modify",
    context_kind: "dashboard",
    context_ref: String(dashId),
  });
  await postTurnAndWait(page, convId, "Añade un KPI con el total de ventas.");

  // The dashboard spec was replaced by the modify result.
  const after = await page.request.get(`/api/dashboard/${dashId}`);
  expect(after.ok()).toBeTruthy();
  const dash = await after.json();
  expect(dash.spec.title).toBe("Panel modificado (e2e mock)");

  // The PREVIOUS spec was snapshotted into dashboard_versions — proving the
  // single versioned writer ran (not a bare UPDATE).
  const versions = await page.request.get(`/api/dashboard/${dashId}/versions`);
  expect(versions.ok()).toBeTruthy();
  const list = await versions.json();
  expect(Array.isArray(list) ? list.length : list.versions?.length ?? 0).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Analyze: submit_dashboard_analysis → markdown persisted on the assistant turn
// ---------------------------------------------------------------------------

test("analyze runs the tool loop and stores the analysis markdown", async ({ page }) => {
  const dashId = await createDashboard(page);
  const convId = await createConversation(page, {
    mode: "analyze",
    context_kind: "dashboard",
    context_ref: String(dashId),
  });
  await postTurnAndWait(page, convId, "Analiza este panel.");

  const conv = await page.request.get(`/api/conversations/${convId}`);
  expect(conv.ok()).toBeTruthy();
  const data = await conv.json();
  const assistant = data.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistant.length).toBeGreaterThan(0);

  // Assert the submit_dashboard_analysis tool actually SUCCEEDED — not merely
  // that the markdown string appears in the persisted call args (which would
  // pass even on INVALID_ARGS). The tool record carries success + its result.
  const toolCalls = assistant.flatMap(
    (m: { content?: { tool_calls?: Array<Record<string, unknown>> } }) =>
      m.content?.tool_calls ?? [],
  );
  const submit = toolCalls.find((c: Record<string, unknown>) => c.name === "submit_dashboard_analysis") as
    | { success?: boolean; arguments?: { analysis_markdown?: string } }
    | undefined;
  expect(submit, "submit_dashboard_analysis was never called").toBeTruthy();
  // success=true proves the args matched the tool schema and the handler staged
  // the result (an INVALID_ARGS mismatch would be success=false).
  expect(submit!.success).toBe(true);
  expect(submit!.arguments?.analysis_markdown).toContain("Análisis");
});

// ---------------------------------------------------------------------------
// Generate: spec JSON → validation → server-side save → linked conversation
// ---------------------------------------------------------------------------

test("generate validates the model spec and saves the dashboard server-side", async ({
  page,
}) => {
  const resp = await page.request.post("/api/dashboard/generate", {
    data: { prompt: "Créame un panel de ventas.", stream: true },
  });
  expect(resp.ok()).toBeTruthy();

  // Consume the NDJSON stream to the result line.
  const body = await resp.text();
  const lines = body
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const result = lines.find((l) => l.type === "result");
  expect(result, "stream produced no result line").toBeTruthy();
  const dashboardId = result!.dashboardId as number;
  expect(Number.isInteger(dashboardId)).toBe(true);

  // The dashboard really exists with the generated (validated) spec.
  const dash = await page.request.get(`/api/dashboard/${dashboardId}`);
  expect(dash.ok()).toBeTruthy();
  expect((await dash.json()).spec.widgets.length).toBeGreaterThan(0);
});
