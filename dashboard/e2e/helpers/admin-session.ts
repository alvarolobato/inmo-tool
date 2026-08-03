/**
 * Seeds the `ps_admin` session cookie the way `/admin/login` does.
 *
 * `middleware.ts` gates *every* UI page on this cookie, not just `/admin/*` —
 * a single-operator tool where the candidate list, map and property detail all
 * render private investment research. Specs that navigate to any page without
 * it get a 307 to the login screen, and then every assertion fails against a
 * page that is in fact perfectly healthy.
 *
 * That is exactly what had happened: candidates/property-detail/feedback/
 * scoring were all red for this reason alone (12 tests), so the regression net
 * over the candidate surfaces was not actually running. Hoisted into a helper
 * when #152 hit the same wall, so the next spec to be written copies something
 * that works.
 */
import type { Page } from "@playwright/test";

export const adminKey = process.env.ADMIN_API_KEY?.trim();

export async function seedAdminSession(page: Page, baseURL: string | undefined): Promise<void> {
  if (!adminKey) return;
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey, url: baseURL ?? "http://localhost:4000" },
  ]);
}
