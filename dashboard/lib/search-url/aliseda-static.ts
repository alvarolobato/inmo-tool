/**
 * Aliseda STATIC-ASSET filter extractor (issue #377, D-093) — server-side.
 *
 * ─── Why static assets, not a DOM scrape ─────────────────────────────────────
 * Aliseda is an Angular Material SPA: its property-type filter is a `mat-select`
 * whose options render into an overlay ONLY after a click. The passive
 * DOM-scrape enumerator (browser-extension/discover.js) structurally cannot read
 * it — it either captured nothing or grabbed branding junk (the logo). So for
 * Aliseda we RETIRE the passive DOM pass (kept for Idealista, which is
 * server-rendered) and read the filter→URL mapping from the portal's STATIC,
 * robots-allowed assets instead — literally how the ático fix (D-062) was found:
 *
 *   1. Category sitemap (`/sitemap-category-aliseda-es-0.xml`, declared from
 *      robots.txt → `/sitemap-index-aliseda.xml`): enumerates the live top-level
 *      `comprar-<category>` search paths (viviendas, locales, naves, garajes,
 *      terrenos, edificios, oficinas, trasteros, obras-paradas, negocios, otros).
 *      This is AUTHORITATIVE for the category axis — every URL here resolves.
 *   2. Angular app bundle (`main-<hash>.js`, referenced from the app shell `/`):
 *      carries the i18n route-slug map. The `comprar-viviendas` RESIDENTIAL
 *      subtypes (pisos, duplex, pisos-turisticos, lofts, casas, chalets-adosados,
 *      chalets-pareados — NO `aticos`) live here and nowhere in the sitemap.
 *
 * Verified 2026-08-06: robots.txt, the sitemap index, the category sitemap, the
 * app shell and the hashed `main-*.js` are all GET-able server-side with an
 * honest UA (HTTP 200) — Aliseda's WAF does NOT block these static assets even
 * though it defeats a DOM scrape of the live app. So the extractor runs
 * server-side; there is no need to route the fetch through the extension.
 *
 * ─── What it emits (drift, not self-heal) ────────────────────────────────────
 * The output is a `CatalogAxes` (the same shape the extension's discovery POST
 * produces) fed to `lib/search-url/drift.ts::computePortalDrift` against the
 * Aliseda builder's `codeMapping()` — flagging ADDED / REMOVED / CHANGED on
 * /etl/discovery so a HUMAN updates `aliseda.ts`. URL building stays 100%
 * code-driven (D-090); this never feeds URL construction.
 *
 * To keep the flag a genuine CHANGE signal (not permanently red), the emitted
 * catalog mirrors what the code cares about, sourced live:
 *   - each builder slug that is STILL present in the live assets is emitted
 *     (so a builder slug that VANISHES is absent → REMOVED — the ático-class
 *     bug: our `/comprar-viviendas/pisos` URL would 404);
 *   - a live category/subtype the code does NOT already KNOW (not in
 *     CATEGORY_SLUGS / VIVIENDA_SUBTYPE_SLUGS) is emitted → ADDED (a genuinely
 *     new taxonomy entry, e.g. a real `aticos` the code folds into `pisos`).
 * Categories/subtypes the code knows but deliberately doesn't build (duplex,
 * casas, comprar-oficinas, …) are NOT emitted, so day-one is GREEN and only a
 * real portal change lights the flag.
 *
 * The parse functions are pure and unit-tested from captured fixtures (no live
 * network in tests); only `fetchAlisedaStaticAssets` touches the network.
 */

import type { CatalogAxes, CatalogOption } from "./discovered-mapping";
import { lastPathSegment } from "./discovered-mapping";
import {
  alisedaBuilder,
  CATEGORY_SLUGS,
  VIVIENDAS,
  VIVIENDA_SUBTYPE_SLUGS,
} from "./portals/aliseda";

const ORIGIN = "https://www.alisedainmobiliaria.com";

/** Robots-declared sitemap index (from `/robots.txt`). */
export const SITEMAP_INDEX_URL = `${ORIGIN}/sitemap-index-aliseda.xml`;
/** The Spanish category sitemap, declared inside the index. */
export const CATEGORY_SITEMAP_URL = `${ORIGIN}/sitemap-category-aliseda-es-0.xml`;
/** The Angular app shell — carries the `<script src="main-<hash>.js">` ref. */
export const APP_SHELL_URL = `${ORIGIN}/`;

// ── Pure parsers (fixture-tested) ────────────────────────────────────────────

/**
 * Distinct top-level `comprar-<category>` slugs the category sitemap enumerates
 * (the FIRST path segment of every `<loc>`). Authoritative for the live
 * category axis. Pure.
 */
export function parseCategorySitemap(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /alisedainmobiliaria\.com\/(comprar-[a-z0-9-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * The `comprar-viviendas` RESIDENTIAL subtype slugs from the app bundle's i18n
 * route-slug map. The bundle carries a self-mapping dictionary
 * (`…,"comprar-todos":"comprar-todos",pisos:"pisos",duplex:"duplex",…,"chalets-pareados":"chalets-pareados",garajes:"garajes",…`)
 * whose residential run sits between the last `comprar-*` category key and the
 * first BARE slug that is itself a top-level category (its `comprar-<slug>`
 * exists) — e.g. `garajes` (→ `comprar-garajes`). We take that contiguous run of
 * bare, NON-category slugs. Pure.
 *
 * Robust by construction: a bare slug is a residential subtype iff no
 * `comprar-<slug>` key exists in the same map; the run terminates at the first
 * category-alias slug, so non-residential subtype aliases that follow
 * (`naves-industriales`, `almacenes`, …) are never mis-read as subtypes.
 */
export function parseVivendaSubtypes(bundleJs: string): Set<string> {
  const out = new Set<string>();
  // The route-slug map keys look like `key:"value"` or `"key":"value"`. Collect
  // every `comprar-<slug>` key so we can recognise a bare category-alias slug.
  const categoryAliases = new Set<string>();
  const catKeyRe = /["']?(comprar-[a-z0-9-]+)["']?\s*:/gi;
  let cm: RegExpExecArray | null;
  while ((cm = catKeyRe.exec(bundleJs)) !== null) {
    // Strip the `comprar-` prefix → the bare alias (`comprar-garajes` → `garajes`).
    categoryAliases.add(cm[1].slice("comprar-".length).toLowerCase());
  }

  // Anchor on the residential run: everything after the `comprar-todos` category
  // key (the last of the category block) up to the first bare category-alias.
  const anchor = /["']?comprar-todos["']?\s*:\s*["']comprar-todos["']\s*,/.exec(bundleJs);
  const from = anchor ? anchor.index + anchor[0].length : -1;
  if (from < 0) return out;

  // Walk `key:"value"` pairs from the anchor; stop at the first bare slug that is
  // a known category alias, or at the first non-slug token / object close.
  const pairRe = /["']?([a-z0-9-]+)["']?\s*:\s*["']([a-z0-9-]+)["']\s*,?/giy;
  pairRe.lastIndex = from;
  let pm: RegExpExecArray | null;
  while ((pm = pairRe.exec(bundleJs)) !== null) {
    const key = pm[1].toLowerCase();
    if (key.startsWith("comprar-")) break; // back into a category block
    if (categoryAliases.has(key)) break; // e.g. `garajes` → end of residential run
    out.add(key);
  }
  return out;
}

// ── Catalog assembly (pure) ──────────────────────────────────────────────────

/** Human, Spanish-ish label from a slug: `comprar-locales` → "Locales", `chalets-adosados` → "Chalets adosados". */
export function labelFromSlug(slug: string): string {
  const words = slug.replace(/^comprar-/, "").replace(/-/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

/** The Aliseda builder's property-type code mapping, indexed by slug. */
function builderBySlug() {
  const axis = alisedaBuilder.codeMapping().property_type ?? [];
  const bySlug = new Map<string, (typeof axis)[number]>();
  for (const opt of axis) bySlug.set(opt.slug, opt);
  return bySlug;
}

/**
 * Assemble the `property_type` catalog axis from the live category + subtype
 * sets, following the emit rule documented at the top of this file. Pure — the
 * fetch is separate — so it is fully unit-testable from fixtures.
 */
export function buildAlisedaStaticCatalog(input: {
  categorySlugs: ReadonlySet<string>;
  vivendaSubtypeSlugs: ReadonlySet<string>;
}): CatalogAxes {
  const { categorySlugs, vivendaSubtypeSlugs } = input;
  const options: CatalogOption[] = [];
  const emitted = new Set<string>();

  const emit = (opt: CatalogOption) => {
    const slug = lastPathSegment(opt.urlFragment);
    if (!slug || emitted.has(slug)) return;
    emitted.add(slug);
    options.push(opt);
  };

  const builder = builderBySlug();

  // 1. Builder slugs still present in the live assets → emit (their absence
  //    surfaces as REMOVED). Category builder slugs are checked against the
  //    sitemap; residential builder slugs against the bundle.
  for (const [slug, opt] of builder) {
    if (slug.startsWith("comprar-")) {
      if (categorySlugs.has(slug)) emit({ label: labelFromSlug(slug), urlFragment: `/${slug}` });
    } else if (vivendaSubtypeSlugs.has(slug)) {
      const o: CatalogOption = {
        label: labelFromSlug(slug),
        urlFragment: `/${VIVIENDAS}/${slug}`,
      };
      if (typeof opt.code === "number") o.subtipo = opt.code;
      emit(o);
    }
  }

  // 2. Live categories the code does NOT already know → ADDED. Exclude the
  //    residential PARENT (`comprar-viviendas`) and the `comprar-todos` pseudo —
  //    neither is a leaf property-type filter.
  for (const slug of categorySlugs) {
    if (slug === VIVIENDAS || slug === "comprar-todos") continue;
    if (!CATEGORY_SLUGS.has(slug)) emit({ label: labelFromSlug(slug), urlFragment: `/${slug}` });
  }

  // 3. Live residential subtypes the code does NOT already know → ADDED (a
  //    genuinely new subtype, e.g. a real `aticos` the code folds into `pisos`).
  for (const slug of vivendaSubtypeSlugs) {
    if (!VIVIENDA_SUBTYPE_SLUGS.has(slug)) {
      emit({ label: labelFromSlug(slug), urlFragment: `/${VIVIENDAS}/${slug}` });
    }
  }

  return { property_type: options };
}

// ── Server-side fetch (network; not exercised by unit tests) ─────────────────

/** Extract the `main-<hash>.js` app-bundle URL from the shell HTML, or null. */
export function appBundleUrlFromShell(html: string): string | null {
  const m = /<script[^>]+src="([^"]*main-[A-Za-z0-9]+\.js)"/i.exec(html);
  if (!m) return null;
  const src = m[1];
  return src.startsWith("http") ? src : `${ORIGIN}/${src.replace(/^\//, "")}`;
}

const HONEST_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inmo-tool/1.0 (+filter-drift-detection)";

async function getText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": HONEST_UA, Accept: "text/html,application/xml,*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch Aliseda's static assets server-side and return the raw category sitemap
 * XML + app-bundle JS. Only robots-allowed/public static assets are fetched (the
 * sitemaps are declared in robots.txt; the app shell `/` and the hashed bundle
 * are not disallowed). `fetchImpl` is injectable for tests. Never called from a
 * client component.
 */
export async function fetchAlisedaStaticAssets(
  fetchImpl: typeof fetch = fetch,
): Promise<{ sitemapXml: string; bundleJs: string; bundleUrl: string }> {
  const [sitemapXml, shellHtml] = await Promise.all([
    getText(CATEGORY_SITEMAP_URL, fetchImpl),
    getText(APP_SHELL_URL, fetchImpl),
  ]);
  const bundleUrl = appBundleUrlFromShell(shellHtml);
  if (!bundleUrl) throw new Error("No se pudo localizar el bundle main-*.js en el shell de Aliseda");
  const bundleJs = await getText(bundleUrl, fetchImpl);
  return { sitemapXml, bundleJs, bundleUrl };
}

/**
 * End-to-end server-side extraction: fetch → parse → assemble the catalog axes.
 * Returns the `CatalogAxes` ready to persist to `portal_filter_catalog` and diff
 * via `computePortalDrift`. Network; not unit-tested.
 */
export async function extractAlisedaStaticCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<{ axes: CatalogAxes; bundleUrl: string }> {
  const { sitemapXml, bundleJs, bundleUrl } = await fetchAlisedaStaticAssets(fetchImpl);
  const categorySlugs = parseCategorySitemap(sitemapXml);
  const vivendaSubtypeSlugs = parseVivendaSubtypes(bundleJs);
  const axes = buildAlisedaStaticCatalog({ categorySlugs, vivendaSubtypeSlugs });
  return { axes, bundleUrl };
}
