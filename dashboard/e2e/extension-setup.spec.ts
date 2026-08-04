/**
 * E2E: extension setup page (issue #256, D-041).
 *
 * The setup page has no DB dependency — it renders the dashboard's own origin,
 * fetches ADMIN_API_KEY from GET /api/extension/key, and offers the extension
 * download. So this spec only needs an admin session (and ADMIN_API_KEY set on
 * the server so the key route answers). Skips cleanly when the key is unset,
 * matching the other specs.
 *
 * Asserts the D-041 bar (no error surface) plus real content: the API URL, a
 * masked key that reveals to the real value, and a working download affordance.
 * Admin-gated by middleware (`/etl/:path*` UI + `/api/extension/*` API).
 */
import { test, expect } from "@playwright/test";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("renders URL, a masked-then-revealed key and a download link, no error surface", async ({
  page,
  baseURL,
}) => {
  await page.goto("/etl/extension");
  await expect(page.getByTestId("extension-setup-page")).toBeVisible();

  // 2. API URL — the origin the operator is on.
  const expectedOrigin = new URL(baseURL ?? "http://localhost:4000").origin;
  await expect(page.getByTestId("extension-api-url")).toHaveText(expectedOrigin);

  // 3. API key — masked by default, then reveals to the real ADMIN_API_KEY.
  const keyEl = page.getByTestId("extension-api-key");
  await expect(keyEl).not.toHaveText(adminKey!); // masked at first
  await expect(keyEl).toContainText("•");
  await page.getByTestId("extension-api-key-reveal").click();
  await expect(keyEl).toHaveText(adminKey!);

  // 1. Download affordance points at the admin-gated route.
  await expect(page.getByTestId("extension-download-btn")).toHaveAttribute(
    "href",
    "/api/extension/download",
  );

  // Copy buttons are present and enabled.
  await expect(page.getByTestId("extension-api-url-copy")).toBeEnabled();
  await expect(page.getByTestId("extension-api-key-copy")).toBeEnabled();

  // D-041 bar: no error surface.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("No se pudo obtener la clave")).toHaveCount(0);
});
