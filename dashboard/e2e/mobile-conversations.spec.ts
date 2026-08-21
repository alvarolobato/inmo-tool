/**
 * E2E (issue #573): chat on mobile — `/conversations/[id]`'s two-pane
 * split view collapses to a single pane below `md` (768px), and the
 * `/conversations` list stays usable at phone width.
 *
 * `/conversations/[id]` opens a long-lived SSE connection
 * (`/api/conversations/[id]/stream`) the instant it mounts — `page.goto`
 * with `waitUntil: "networkidle"` never resolves on that route (confirmed:
 * a 60s test timeout waiting on it). Every navigation to it in this file
 * uses `waitUntil: "load"` plus an explicit visible-marker wait instead,
 * matching this project's `gotoAndSettle` pattern
 * (`mobile-main-content-padding.spec.ts`) but swapping the wait strategy
 * for this one SSE-backed route.
 *
 * Markdown-table containment (the issue's Task 2,
 * `ConversationPane.tsx`'s `table:` renderer) was found ALREADY WRAPPED in
 * `overflowX: "auto"` while investigating this issue — inherited from the
 * source project's original BI-dashboard chat component, not something
 * this PR needed to add. Not covered by a new test here for that reason;
 * `git blame` on that line predates this project's inmo-tool history.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching mobile-profiles.spec.ts.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { Pool } from "pg";
import crypto from "crypto";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

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

function genConversationId(): string {
  // Matches generateConversationId()'s shape: lowercase 12-char hex.
  return crypto.randomBytes(6).toString("hex");
}

const NAME_PREFIX = "e2e-mobile-conv-";

let pool: Pool;
let dbAvailable = false;
let convId: string;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[mobile-conversations.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  convId = genConversationId();
  await pool.query(
    `INSERT INTO conversations (id, mode, title, context_kind, created_at, last_interaction_at)
     VALUES ($1, 'generate', $2, 'global', NOW(), NOW())`,
    [convId, `${NAME_PREFIX}conversación de prueba móvil`],
  );
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2::jsonb)`,
    [convId, JSON.stringify(`${NAME_PREFIX}Hola, esto es un mensaje de prueba`)],
  );
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2::jsonb)`,
    [convId, JSON.stringify({ text: `${NAME_PREFIX}Respuesta de prueba` })],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM conversation_messages WHERE conversation_id = $1", [convId]);
  await pool.query("DELETE FROM conversations WHERE id = $1", [convId]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

// `/conversations/[id]` keeps an SSE connection open forever — never
// "networkidle" on this one route. "load" + a visible marker + a fixed
// settle is this file's equivalent of gotoAndSettle for it.
async function gotoConversationAndSettle(page: Page, id: string): Promise<void> {
  await page.goto(`/conversations/${id}`, { waitUntil: "load" });
  await expect(page.getByTestId("message-input"), "the conversation pane rendered").toBeVisible();
  await page.waitForTimeout(1000);
}

async function clientWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.clientWidth);
}

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("chat collapses to a single usable pane", async ({ page }) => {
    skipIfNoDb(test);

    await gotoConversationAndSettle(page, convId);
    const width = await clientWidth(page);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);

    // The sidebar must be genuinely hidden (display: none via the
    // `hidden md:flex` class), not just visually squeezed — asserting
    // `display`, the real CSS property the fix controls, not a proxy.
    const sidebarDisplay = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="conversation-list-sidebar"]');
      return el ? getComputedStyle(el).display : "not-found";
    });
    expect(sidebarDisplay, "sidebar is display:none below md").toBe("none");

    const backLink = page.getByTestId("mobile-back-to-list");
    await expect(backLink, "back-to-list link is visible").toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/conversations");

    // The real, falsifiable width the issue names directly — was ~66px
    // pre-fix (110px pane minus ConversationPane's own padding/bubble
    // maxWidth math), must clear the issue's own 200px composer floor.
    const composerBox = await page.getByTestId("message-input").boundingBox();
    expect(composerBox, "composer has a bounding box").not.toBeNull();
    if (composerBox) {
      expect(composerBox.width, "composer textarea is wide enough to type into").toBeGreaterThanOrEqual(200);
    }

    // No horizontal overflow on the pane itself.
    const main = await page.evaluate(() => {
      const m = document.querySelector("main.main-content")!;
      return { clientWidth: m.clientWidth, scrollWidth: m.scrollWidth };
    });
    expect(main.scrollWidth, "main.main-content has no horizontal overflow").toBeLessThanOrEqual(
      main.clientWidth + 1,
    );
  });

  test("desktop split view still renders both panes (sanity check for the md breakpoint)", async ({
    page,
  }) => {
    skipIfNoDb(test);
    await page.setViewportSize({ width: 1280, height: 900 });

    await gotoConversationAndSettle(page, convId);
    const sidebarDisplay = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="conversation-list-sidebar"]');
      return el ? getComputedStyle(el).display : "not-found";
    });
    expect(sidebarDisplay, "sidebar renders at desktop width").not.toBe("none");

    const backLinkDisplay = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="mobile-back-to-list"]');
      return el ? getComputedStyle(el).display : "not-found";
    });
    expect(backLinkDisplay, "mobile-only back link is hidden at desktop width").toBe("none");
  });

  test("list shows titles at phone width, no document horizontal overflow", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto("/conversations", { waitUntil: "networkidle" });
    await expect(page.getByTestId("conversations-table")).toBeVisible();
    await page.waitForTimeout(1000);

    const width = await clientWidth(page);
    const titleCell = page.getByTestId(`title-cell-${convId}`);
    await expect(titleCell, "the seeded conversation's title cell is visible").toBeVisible();
    const box = await titleCell.boundingBox();
    expect(box, "title cell has a real, non-collapsed width").not.toBeNull();
    if (box) {
      // The pre-fix 976px/10-column fixed table collapsed Título toward 0
      // at 390px (it only kept width via what was left after 9 fixed
      // columns). A real width floor, not just ">0", is the falsifiable
      // assertion here.
      expect(box.width, "title cell has meaningful width, not collapsed").toBeGreaterThan(80);
    }

    const offenders = await page.evaluate((clientW) => {
      const bad: { tag: string; testid: string | null; right: number }[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > clientW + 1) {
          bad.push({ tag: el.tagName, testid: el.getAttribute("data-testid"), right: Math.round(rect.right) });
        }
      });
      return bad;
    }, width);
    expect(offenders, "no element extends past the document at phone width").toEqual([]);
  });
});
