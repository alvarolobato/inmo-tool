import { type Page, expect } from "@playwright/test";

/**
 * Candidate-feed filter bar helpers (#465, Feed UX F2).
 *
 * The 7 AI-gated filters (occupancy, condition, caveat, redflag, beach,
 * heritage, vpo) moved from the flat bar into a progressive-disclosure
 * "Más filtros" popover. Specs that drive those controls must open the popover
 * first; the primary-row controls (view segment, source, below-market) stay
 * directly reachable.
 */

/** Open the "Más filtros" popover if it isn't already open (idempotent). */
export async function openMoreFilters(page: Page): Promise<void> {
  const panel = page.getByTestId("more-filters-panel");
  if (await panel.isVisible().catch(() => false)) return;
  await page.getByTestId("more-filters-button").click();
  await expect(panel).toBeVisible();
}
