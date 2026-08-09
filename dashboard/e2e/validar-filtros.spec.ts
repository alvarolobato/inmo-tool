/**
 * E2E (D-041): the "Validar filtros" page + ⋮ menu entry (issue #478 P2).
 *
 * Drives a real Next.js server against a real Postgres. Seeds ONE search
 * profile and ONE idealista override (profile_connector_filter, the Phase-1
 * tier-0 store). Then:
 *   - navigates to the page from the profile's ⋮ menu (the P2 entry point);
 *   - asserts the idealista row shows an "URL fijada" badge and the seeded URL
 *     VERBATIM, and the aliseda row shows a "derivada del perfil" badge;
 *   - pins a new URL on the aliseda row and asserts it persists + re-renders
 *     (badge flips to "URL fijada", URL updated);
 *   - asserts no error surface (D-041 bar);
 *   - asserts that on /captura the idealista task now uses the pinned URL —
 *     via GET /api/profiles/[id]/search-urls (the task's url), i.e. on the
 *     task URL itself, not window.open.
 *
 * Admin-gated like every page (middleware.ts). Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset — matching the other specs.
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { seedAdminSession, adminKey } from "./helpers/admin-session";

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

const PROFILE_NAME = "E2E-478P2 Validar filtros";
const SCOPE = {
  geography: { type: "radius", center: [37.3891, -5.9845], radius_km: 5 },
  property_types: ["piso"],
  price_max: 200000,
};
// A hand-tuned idealista URL pinned as this profile's idealista filter (tier 0).
// A real DRAWN-POLYGON (`shape=`) URL (#471): the owner-captured Dos Hermanas
// specimen (10-vertex ring). Before #471 this grammar decoded to "no se pudo
// validar"; now the Validar filtros page decodes it into a vertex-count chip.
const PINNED_IDEALISTA =
  "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_175000/mapa-google?shape=%28%28%7DhpbFl%7Clc%40asJia%40unDijBl_%40coElp%40glA%7C%7EFslCpvJmTpp%40vuFurA%7CdHobCjp%40%29%29";
// A hand-tuned aliseda URL the test pins during the run.
const NEW_ALISEDA =
  "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/sevilla/?precio=0-175000";
// #497: an altamira URL the test pins verbatim. Altamira has no verified grammar
// (Akamai WAF) — no builder, no parser — so the row offers NO inference, only a
// verbatim pin under its host (altamirainmuebles.com).
const NEW_ALTAMIRA =
  "https://www.altamirainmuebles.com/es/venta/viviendas/sevilla/sevilla";
// P4: the ETL-connector previews section. `pisos` is a tunable HTTP connector
// (a real search page + an override_host_suffix); `cimenta2` is non-tunable
// (national sitemap sweep). Both are seeded into the registry + preview tables
// exactly as etl.orchestrator.sync_connector_registry / publish_search_previews
// would publish them.
const PISOS_PREVIEW_URL = "https://www.pisos.com/venta/pisos-sevilla/";
const CIMENTA2_PREVIEW_URL = "https://inmuebles.cimenta2.com/inmuebles/s/sitemap.xml";
// A hand-tuned pisos URL the test pins on the ETL section.
const NEW_PISOS = "https://www.pisos.com/venta/pisos-sevilla/1-habitacion/";

// A second profile so the ProfileSwitcher has somewhere to switch TO.
const PROFILE_NAME_2 = "E2E-478P2 Validar filtros (segundo)";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let profileId2: number;

async function purge(): Promise<void> {
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM search_profile WHERE name = ANY($1)",
    [[PROFILE_NAME, PROFILE_NAME_2]],
  );
  for (const { id } of existing.rows) {
    // profile_connector_filter cascades on profile delete, but clear the other
    // FK children a running dev server may have materialized first.
    await pool.query("DELETE FROM profile_connector_filter WHERE profile_id = $1", [id]).catch(() => undefined);
    for (const table of ["capture_task_run", "profile_listing_state", "feedback_event"]) {
      await pool.query(`DELETE FROM ${table} WHERE profile_id = $1`, [id]).catch(() => undefined);
    }
  }
  await pool.query("DELETE FROM search_profile WHERE name = ANY($1)", [[PROFILE_NAME, PROFILE_NAME_2]]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[validar-filtros.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [PROFILE_NAME, JSON.stringify(SCOPE)],
  );
  profileId = r.rows[0].id;
  const r2 = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [PROFILE_NAME_2, JSON.stringify(SCOPE)],
  );
  profileId2 = r2.rows[0].id;
  // Seed a whole-connector ('') idealista override so the idealista task is
  // governed by it (tier 0) — the "URL fijada" case.
  await pool.query(
    `INSERT INTO profile_connector_filter (profile_id, connector, section_key, url, source)
     VALUES ($1, 'idealista', '', $2, 'manual')`,
    [profileId, PINNED_IDEALISTA],
  );

  // P4/#491: stand in for what the ETL publishes — the pisos (tunable, with a
  // URL grammar) + cimenta2 (non-tunable, no grammar) registry rows and their
  // per-profile previews (now carrying params).
  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters, override_host_suffix, supports_search_override,
        search_url_grammar)
     VALUES ('pisos', true, 20, false, true, '[]'::jsonb, 'pisos.com', false, $1::jsonb),
            ('habitaclia', true, 20, false, true, '[]'::jsonb, 'habitaclia.com', true, $2::jsonb),
            ('fotocasa', true, 3, false, true, '["rooms"]'::jsonb, 'fotocasa.es', true, $3::jsonb),
            ('unicaja', true, 20, true, true, '[]'::jsonb, 'unicajainmuebles.com', true, $4::jsonb),
            ('servihabitat', true, 12, false, true, '[]'::jsonb, 'servihabitat.com', true, $5::jsonb),
            ('escogecasa', true, 20, false, true, '[]'::jsonb, NULL, false, NULL),
            ('cimenta2', true, 20, true, true, '[]'::jsonb, NULL, false, NULL),
            -- Issue #513: a tunable connector with a grammar but DELIBERATELY no
            -- preview row (not in seedEtlPreviews) → the page must derive its URL
            -- on demand from the grammar and the profile's province.
            ($6, true, 20, false, true, '[]'::jsonb, 'e2e-derived.example', true, $7::jsonb)
     ON CONFLICT (connector_name) DO UPDATE SET
       registered = true, supports_discovery = true,
       override_host_suffix = EXCLUDED.override_host_suffix,
       supports_search_override = EXCLUDED.supports_search_override,
       search_url_grammar = EXCLUDED.search_url_grammar`,
    [
      JSON.stringify(PISOS_GRAMMAR),
      JSON.stringify(HABITACLIA_GRAMMAR),
      JSON.stringify(FOTOCASA_GRAMMAR),
      JSON.stringify(UNICAJA_GRAMMAR),
      JSON.stringify(SERVIHABITAT_GRAMMAR),
      DERIVED_CONNECTOR,
      JSON.stringify(DERIVED_GRAMMAR),
    ],
  );
  await seedEtlPreviews();
  // Issue #515: give the non-tunable escogecasa row a home_url (as
  // sync_connector_registry now publishes from Connector.home_url) so the ETL
  // "Abrir portal" fallback (EC-2) has a browseable target. The main INSERT's ON
  // CONFLICT clause doesn't touch home_url, so this UPDATE persists across reseeds.
  await pool.query(
    "UPDATE connector_registry SET home_url = 'https://www.escogecasa.es' WHERE connector_name = 'escogecasa'",
  );
});

// Issue #513: a synthetic connector used ONLY to exercise the on-demand derived
// preview (its registry row is seeded with a grammar but NO connector_search_
// preview row). A single province-sourced param so the built URL round-trips
// with just the profile's resolved province filled in.
const DERIVED_CONNECTOR = "e2e-derived";
const DERIVED_GRAMMAR = {
  build_template: "https://e2e-derived.example/buscar-{province}/",
  parse_pattern:
    "^https?://(?:www\\.)?e2e-derived\\.example/buscar-(?<province>[^/]+)/$",
  params: { province: { label: "Provincia", source: "profile" } },
};
// The profile's Sevilla centre resolves via provinceForPoint → "sevilla".
const DERIVED_EXPECTED_URL = "https://e2e-derived.example/buscar-sevilla/";

// The pisos search-URL grammar exactly as etl.orchestrator.sync_connector_registry
// publishes it (ECMAScript-canonical parse pattern — the browser's RegExp uses it).
const PISOS_GRAMMAR = {
  build_template: "https://www.pisos.com/venta/pisos-{geography}/",
  parse_pattern: "^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$",
  params: { geography: { label: "Municipio", source: "profile" } },
};

// The habitaclia grammar exactly as sync_connector_registry publishes it
// (issue #492): a single geography slug, no query string. The `[^/?#]+` slug
// class + trailing `\.htm$` anchor reject any `?pag=` pagination.
const HABITACLIA_GRAMMAR = {
  build_template: "https://www.habitaclia.com/viviendas-{geography}.htm",
  parse_pattern:
    "^https?://(?:www\\.)?habitaclia\\.com/viviendas-(?<geography>[^/?#]+)\\.htm$",
  params: { geography: { label: "Municipio", source: "profile" } },
};
const HABITACLIA_PREVIEW_URL = "https://www.habitaclia.com/viviendas-sevilla.htm";

// The fotocasa grammar exactly as sync_connector_registry publishes it (issue
// #493): a 3-segment path (geography / zone / optional -habitaciones token) plus
// two robots reject_reasons — ANY query string and a bare city-name slug — that
// the browser turns into a HARD block, not a verbatim pin.
const FOTOCASA_GRAMMAR = {
  build_template:
    "https://www.fotocasa.es/es/comprar/viviendas/{geography}/{zone}/{rooms_segment}l",
  parse_pattern:
    "^https?://(?:www\\.)?fotocasa\\.es/es/comprar/viviendas/(?<geography>[^/]+)/(?<zone>[^/]+)/(?<rooms_segment>(?:[0-9]+-habitaciones/)?)l$",
  params: {
    geography: { label: "Municipio", source: "profile" },
    zone: { label: "Zona", source: "derived" },
    rooms_segment: { label: "Habitaciones (segmento URL)", source: "connector_config" },
  },
  reject_reasons: [
    { pattern: "^https?://(?:www\\.)?fotocasa\\.es/[^?]*\\?", reason: "robots-query-params" },
    {
      pattern:
        "^https?://(?:www\\.)?fotocasa\\.es/es/comprar/viviendas/(?:barcelona|madrid|valencia)/",
      reason: "robots-bare-geography",
    },
  ],
};
// A rooms-filtered fotocasa entry URL (EXACT filter, issue #99).
const FOTOCASA_PREVIEW_URL =
  "https://www.fotocasa.es/es/comprar/viviendas/sevilla-capital/todas-las-zonas/2-habitaciones/l";

// Issue #494: the unicaja query grammar exactly as sync_connector_registry
// publishes it. `provincia` is consumed; every native filter (precioMax,
// numDormitorios, …) is inferrable but NOT consumed yet.
const UNICAJA_GRAMMAR = {
  build_template:
    "https://unicajainmuebles.com/listadoPromocion.do?definitionName=busqueda&tipoInmueble=0&tipoOperacion=1&provincia={provincia}&municipio={municipio}&zona=-1&antiguedadAlta=-1&precioMin={precioMin}&precioMax={precioMax}&codRef=&codigoPostal={codigoPostal}&soloFotos=false&numDormitorios={numDormitorios}&superficieMin={superficieMin}&pagina={pagina}&paginando=true&orden=",
  parse_pattern:
    "^https?://(?:www\\.)?unicajainmuebles\\.com/listadoPromocion\\.do\\?definitionName=busqueda&tipoInmueble=0&tipoOperacion=1&provincia=(?<provincia>[^&]*)&municipio=(?<municipio>[^&]*)&zona=-1&antiguedadAlta=-1&precioMin=(?<precioMin>[^&]*)&precioMax=(?<precioMax>[^&]*)&codRef=&codigoPostal=(?<codigoPostal>[^&]*)&soloFotos=false&numDormitorios=(?<numDormitorios>[^&]*)&superficieMin=(?<superficieMin>[^&]*)&pagina=(?<pagina>[^&]*)&paginando=true&orden=$",
  params: {
    provincia: { label: "Provincia (INE)", source: "profile" },
    municipio: { label: "Municipio", source: "constant", consumed: false },
    precioMin: { label: "Precio mín.", source: "constant", consumed: false },
    precioMax: { label: "Precio máx.", source: "constant", consumed: false },
    codigoPostal: { label: "Código postal", source: "constant", consumed: false },
    numDormitorios: { label: "Dormitorios", source: "constant", consumed: false },
    superficieMin: { label: "Superficie mín.", source: "constant", consumed: false },
    pagina: { label: "Página", source: "derived", consumed: false },
  },
};
const UNICAJA_PREVIEW_URL =
  "https://unicajainmuebles.com/listadoPromocion.do?definitionName=busqueda&tipoInmueble=0&tipoOperacion=1&provincia=29&municipio=-1&zona=-1&antiguedadAlta=-1&precioMin=&precioMax=&codRef=&codigoPostal=&soloFotos=false&numDormitorios=-1&superficieMin=&pagina=1&paginando=true&orden=";

// Issue #495: servihabitat — only the province sitemap round-trips; a faceted
// search URL (any query string) is a robots-forbidden reasoned block.
const SERVIHABITAT_GRAMMAR = {
  build_template: "https://www.servihabitat.com/es/sitemap-es-{province}.xml",
  parse_pattern:
    "^https?://(?:www\\.)?servihabitat\\.com/es/sitemap-es-(?<province>[^./]+)\\.xml$",
  params: { province: { label: "Provincia (sitemap)", source: "profile" } },
  reject_reasons: [
    { pattern: "^https?://(?:www\\.)?servihabitat\\.com/[^?]*\\?", reason: "robots-faceted-search" },
  ],
};
const SERVIHABITAT_PREVIEW_URL = "https://www.servihabitat.com/es/sitemap-es-sevilla.xml";
const ESCOGECASA_PREVIEW_URL = "https://www.escogecasa.es/buscador/cargar_resultados.jsp";

/** (Re)seed the pisos + cimenta2 previews for the profile (P4/#491). */
async function seedEtlPreviews(): Promise<void> {
  await pool.query(
    `INSERT INTO connector_search_preview (profile_id, connector, previews)
     VALUES ($1, 'pisos', $2::jsonb), ($1, 'cimenta2', $3::jsonb), ($1, 'habitaclia', $4::jsonb),
            ($1, 'fotocasa', $5::jsonb), ($1, 'unicaja', $6::jsonb),
            ($1, 'servihabitat', $7::jsonb), ($1, 'escogecasa', $8::jsonb)
     ON CONFLICT (profile_id, connector) DO UPDATE SET
       previews = EXCLUDED.previews, computed_at = NOW()`,
    [
      profileId,
      JSON.stringify([
        {
          label: "Pisos.com — sevilla",
          url: PISOS_PREVIEW_URL,
          kind: "search_page",
          tunable: true,
          notes: null,
          params: [
            { key: "geography", label: "Municipio", value: "sevilla", source: "profile", in_url: true, notes: null },
            { key: "operation", label: "Operación", value: "venta", source: "constant", in_url: true, notes: null },
          ],
        },
      ]),
      JSON.stringify([
        {
          label: "Cimenta2 (Cajamar) — barrido nacional",
          url: CIMENTA2_PREVIEW_URL,
          kind: "sitemap",
          tunable: false,
          notes: "Barrido nacional del sitemap; el scope no entra en la URL — el filtrado es por datos.",
          // Even a non-tunable connector exposes its params (EC-1): here just
          // the constant operation, which does NOT travel in the sitemap URL.
          params: [
            { key: "operation", label: "Operación", value: "venta", source: "constant", in_url: false, notes: null },
          ],
        },
      ]),
      JSON.stringify([
        {
          // issue #492: a tunable single-URL connector with a published grammar
          // (habitaclia). geography (perfil) + operation (constante) chips, and
          // an owner-edited URL re-infers the municipality live in the browser.
          label: "Habitaclia — sevilla",
          url: HABITACLIA_PREVIEW_URL,
          kind: "search_page",
          tunable: true,
          notes: null,
          params: [
            { key: "geography", label: "Municipio", value: "sevilla", source: "profile", in_url: true, notes: null },
            {
              key: "operation",
              label: "Operación",
              value: "venta viviendas",
              source: "constant",
              in_url: true,
              notes: "Solo página 1 — habitaclia bloquea la paginación (*pag=) en robots.txt, así que no viaja en la URL.",
            },
          ],
        },
      ]),
      JSON.stringify([
        {
          // issue #493: fotocasa — a tunable connector with a 3-segment grammar
          // and robots reject_reasons. geography (perfil) + operation
          // (constante) + zone de entrada (derivada) + rooms (config, EXACTO).
          label: "Fotocasa — sevilla-capital",
          url: FOTOCASA_PREVIEW_URL,
          kind: "search_page",
          tunable: true,
          notes: null,
          params: [
            { key: "geography", label: "Municipio", value: "sevilla-capital", source: "profile", in_url: true, notes: null },
            { key: "operation", label: "Operación", value: "comprar", source: "constant", in_url: true, notes: null },
            {
              key: "zone",
              label: "Zona de entrada",
              value: "todas-las-zonas",
              source: "derived",
              in_url: true,
              notes: "La página de entrada usa 'todas-las-zonas'; el barrido recorre ~160 zonas.",
            },
            {
              key: "rooms",
              label: "Habitaciones",
              value: "2",
              source: "connector_config",
              in_url: true,
              notes: "Filtro EXACTO (no mínimo): viaja como '2-habitaciones/'.",
            },
          ],
        },
      ]),
      JSON.stringify([
        {
          // issue #494: unicaja — provincia resolved to a legible INE chip
          // (consumed), plus native filter fields present-but-not-consumed.
          label: "Unicaja — provincia INE 29 · Málaga",
          url: UNICAJA_PREVIEW_URL,
          kind: "search_page",
          tunable: true,
          notes: null,
          params: [
            { key: "provincia", label: "Provincia (INE)", value: "INE 29 · Málaga", source: "profile", in_url: true, notes: null, consumed: true },
            { key: "precioMax", label: "Precio máx.", value: null, source: "constant", in_url: true, notes: "no consumido aún", consumed: false },
            { key: "numDormitorios", label: "Dormitorios", value: null, source: "constant", in_url: true, notes: "no consumido aún", consumed: false },
          ],
        },
      ]),
      JSON.stringify([
        {
          // issue #495: servihabitat — only the province sitemap round-trips; a
          // faceted-search URL is a robots reasoned block.
          label: "Servihabitat — sevilla",
          url: SERVIHABITAT_PREVIEW_URL,
          kind: "sitemap",
          tunable: true,
          notes:
            "La búsqueda facetada de este portal está prohibida por robots.txt; solo el sitemap de provincia es válido.",
          params: [
            { key: "province", label: "Provincia (sitemap)", value: "sevilla", source: "profile", in_url: true, notes: null, consumed: true },
          ],
        },
      ]),
      JSON.stringify([
        {
          // issue #496: escogecasa — non-tunable (POST bbox); surfaces the real
          // params (centro, radio, derived bbox, term) with an honest note.
          label: "Escogecasa (Abanca) — búsqueda por bbox",
          url: ESCOGECASA_PREVIEW_URL,
          kind: "api",
          tunable: false,
          notes:
            "Búsqueda por POST de un bounding box a este endpoint; no es una URL GET afinable — el filtrado es por datos.",
          params: [
            { key: "tgs", label: "Categoría", value: "viviendas", source: "constant", in_url: false, notes: null, consumed: true },
            { key: "centro", label: "Centro", value: "37.389100, -5.984500", source: "profile", in_url: false, notes: null, consumed: true },
            { key: "radio_km", label: "Radio", value: "30 km", source: "constant", in_url: false, notes: null, consumed: true },
            { key: "bbox", label: "Bounding box", value: "37.118830…37.659370 × -6.324664…-5.644336", source: "derived", in_url: false, notes: "Caja calculada con bbox_from_center; ~100 markers máx. por caja.", consumed: true },
          ],
        },
      ]),
    ],
  );
}

test.afterAll(async () => {
  if (dbAvailable) {
    await purge();
    // Issue #513: the synthetic derived-preview connector isn't a real fleet
    // member — remove its registry row so it doesn't linger in a shared dev DB.
    await pool
      .query("DELETE FROM connector_registry WHERE connector_name = $1", [DERIVED_CONNECTOR])
      .catch(() => undefined);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
}

test("navigate from ⋮ menu; pinned + derived rows; save persists; captura uses the pin", async ({
  page,
}) => {
  // 1) Reach the page from the profile row's ⋮ menu.
  await page.goto("/profiles");
  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /más acciones/i }).click();
  await page.getByRole("menuitem", { name: "Validar filtros" }).click();
  // The filtros route is brand-new, so `npm run dev` compiles it on-demand on
  // first hit; App Router only commits the URL once the RSC payload resolves,
  // which can exceed the default 5s expect timeout on a cold compile in CI.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/filtros`), { timeout: 30_000 });
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  // 2) Idealista row → "URL fijada" + the seeded URL verbatim.
  const ideaRow = page.locator('[data-testid="filter-validation-row"][data-connector="idealista"]');
  await expect(ideaRow).toBeVisible();
  await expect(ideaRow.getByTestId("filter-source-badge")).toHaveText("URL fijada");
  await expect(ideaRow.getByTestId("filter-url")).toHaveText(PINNED_IDEALISTA);
  // The URL field is a single line (no wrap) — the Copiar button gives the full value.
  await expect(ideaRow.getByTestId("filter-url")).toHaveCSS("white-space", "nowrap");
  // #471: the drawn-polygon (shape=) URL is now DECODED, not "unparseable" —
  // the row shows a vertex-count chip instead of "no se pudo validar".
  await expect(ideaRow.getByTestId("filter-unparseable")).toHaveCount(0);
  await expect(ideaRow.getByTestId("filter-chips")).toContainText("polígono dibujado");

  // 2b) Aliseda row → derived (no pin yet). #497: the derived URL is decoded by
  //     the aliseda inverse parser into chips (price/zone), not "no se pudo validar".
  const aliRow = page.locator('[data-testid="filter-validation-row"][data-connector="aliseda"]');
  await expect(aliRow).toBeVisible();
  await expect(aliRow.getByTestId("filter-source-badge")).toHaveText("derivada del perfil");
  await expect(aliRow.getByTestId("filter-unparseable")).toHaveCount(0);
  await expect(aliRow.getByTestId("filter-chips")).toContainText("Precio");

  // 2c) The transient Phase-2 "abrir sin señal" note is gone (Phase 3); a
  //     permanent validation-mode hint replaces it.
  await expect(page.getByTestId("validar-filtros-open-note")).toHaveCount(0);
  await expect(page.getByTestId("validar-filtros-open-hint")).toBeVisible();

  // 3) Pin a new URL on the aliseda row → persists + re-renders.
  await aliRow.getByTestId("filter-url-input").fill(NEW_ALISEDA);
  await aliRow.getByTestId("filter-save").click();
  // After router.refresh() the aliseda row is now pinned with the new URL.
  await expect(aliRow.getByTestId("filter-source-badge")).toHaveText("URL fijada");
  await expect(aliRow.getByTestId("filter-url")).toHaveText(NEW_ALISEDA);
  await assertNoErrorSurface(page);

  // 4) /captura uses the pinned idealista URL — assert on the task's URL itself
  //    (via the search-urls API), not window.open.
  const res = await page.request.get(`/api/profiles/${profileId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { tasks: { portal: string; url: string; overridden?: boolean }[] };
  const ideaTask = body.tasks.find((t) => t.portal === "idealista");
  expect(ideaTask).toBeDefined();
  expect(ideaTask!.url).toBe(PINNED_IDEALISTA);
  expect(ideaTask!.overridden).toBe(true);
  const aliTask = body.tasks.find((t) => t.portal === "aliseda");
  expect(aliTask!.url).toBe(NEW_ALISEDA);
  expect(aliTask!.overridden).toBe(true);

  // The captura page renders without an error surface and shows the pinned URL
  // on the idealista task's launch button (title = task.url).
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();
  await assertNoErrorSurface(page);
  const ideaConn = page.getByTestId(`captura-connector-${profileId}-idealista`);
  await expect(ideaConn).toBeVisible();
  await expect(ideaConn.locator(`[title="${PINNED_IDEALISTA}"]`).first()).toBeVisible();
});

test("altamira: verbatim-pin row — honest note, zero inference, pin persists (#497)", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const altaRow = page.locator('[data-testid="filter-validation-row"][data-connector="altamira"]');
  await expect(altaRow).toBeVisible();
  // No verified grammar → an honest note, "sin URL fijada" badge, and NO chips /
  // no misleading "no se pudo descodificar" note.
  await expect(altaRow.getByTestId("filter-verbatim-note")).toContainText("se usa tal cual");
  await expect(altaRow.getByTestId("filter-source-badge")).toHaveText("sin URL fijada");
  await expect(altaRow.getByTestId("filter-chips")).toHaveCount(0);
  await expect(altaRow.getByTestId("filter-unparseable")).toHaveCount(0);

  // Pin a URL verbatim → persists + re-renders as "URL fijada", shown verbatim,
  // and the honest note stays (still no inference offered).
  await altaRow.getByTestId("filter-url-input").fill(NEW_ALTAMIRA);
  await altaRow.getByTestId("filter-save").click();
  await expect(altaRow.getByTestId("filter-source-badge")).toHaveText("URL fijada");
  await expect(altaRow.getByTestId("filter-url")).toHaveText(NEW_ALTAMIRA);
  await expect(altaRow.getByTestId("filter-verbatim-note")).toBeVisible();
  await expect(altaRow.getByTestId("filter-unparseable")).toHaveCount(0);
  await assertNoErrorSurface(page);

  // Clean the pin so the suite can be re-run against a persistent dev DB.
  await pool.query(
    "DELETE FROM profile_connector_filter WHERE profile_id = $1 AND connector = 'altamira'",
    [profileId],
  );
});

test("ETL section: a grammar-bearing connector with no preview shows an on-demand derived URL (issue #513)", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  // This connector has a grammar but NO connector_search_preview row for the
  // profile — the pre-#513 behaviour was a URL-less "pendiente" row. Now the
  // page builds the URL on demand from the grammar + the profile's province.
  const row = page.locator(
    `[data-testid="etl-connector-row"][data-connector="${DERIVED_CONNECTOR}"]`,
  );
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-tunable", "true");
  // Never URL-less: the derived URL is shown, the pending note is gone…
  await expect(row.getByTestId("etl-url")).toHaveText(DERIVED_EXPECTED_URL);
  await expect(row.getByTestId("etl-pending")).toHaveCount(0);
  // …and it's honestly labelled unverified, with the explanatory note.
  await expect(row.getByTestId("etl-source-badge")).toHaveText(
    "derivada (sin verificar por ETL)",
  );
  await expect(row.getByTestId("etl-derived-note")).toBeVisible();
  await assertNoErrorSurface(page);
});

test("ETL section: cimenta2 read-only with its note; pisos tunable and saves (P4)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  const etl = page.getByTestId("validar-filtros-etl-section");
  await expect(etl).toBeVisible();
  await assertNoErrorSurface(page);

  // cimenta2 → non-tunable: shows its URL + honest note, read-only (no input).
  const cimenta2 = page.locator('[data-testid="etl-connector-row"][data-connector="cimenta2"]');
  await expect(cimenta2).toBeVisible();
  await expect(cimenta2).toHaveAttribute("data-tunable", "false");
  await expect(cimenta2.getByTestId("etl-url")).toHaveText(CIMENTA2_PREVIEW_URL);
  await expect(cimenta2.getByTestId("etl-notes")).toBeVisible();
  await expect(cimenta2.getByTestId("etl-readonly")).toBeVisible();
  await expect(cimenta2.getByTestId("etl-url-input")).toHaveCount(0);

  // pisos → tunable: shows the derived URL + a save affordance; pin persists.
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();
  await expect(pisos).toHaveAttribute("data-tunable", "true");
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText("derivada del perfil");
  await expect(pisos.getByTestId("etl-url")).toHaveText(PISOS_PREVIEW_URL);

  await pisos.getByTestId("etl-url-input").fill(NEW_PISOS);
  await pisos.getByTestId("etl-save").click();
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText("URL fijada");
  await expect(pisos.getByTestId("etl-url")).toHaveText(NEW_PISOS);
  await assertNoErrorSurface(page);

  // The pin is a real profile_connector_filter row for the HTTP connector.
  const res = await page.request.get(`/api/profiles/${profileId}/connector-filters`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { rows: { connector: string; url: string }[] };
  expect(body.rows.some((r) => r.connector === "pisos" && r.url === NEW_PISOS)).toBe(true);

  // Clean the pin so the suite can be re-run against a persistent dev DB.
  await pool.query("DELETE FROM profile_connector_filter WHERE profile_id = $1 AND connector = 'pisos'", [profileId]);
});

test("params chips render for every ETL connector row (issue #491 EC-1)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  // Tunable connector (pisos): geography (perfil) + operation (constante) chips.
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos.getByTestId("etl-params")).toBeVisible();
  const geoChip = pisos.locator('[data-testid="etl-param-chip"][data-param-key="geography"]');
  await expect(geoChip).toContainText("Municipio");
  await expect(geoChip).toContainText("sevilla");
  await expect(geoChip).toContainText("perfil");
  await expect(
    pisos.locator('[data-testid="etl-param-chip"][data-param-key="operation"]'),
  ).toContainText("constante");
  // The honest downstream-filter note is present.
  await expect(pisos.getByTestId("etl-downstream-note")).toContainText(
    "se aplican después por datos",
  );

  // Non-tunable connector (cimenta2) ALSO shows its params (EC-1: "incluso en
  // los no afinables").
  const cimenta2 = page.locator('[data-testid="etl-connector-row"][data-connector="cimenta2"]');
  await expect(
    cimenta2.locator('[data-testid="etl-param-chip"][data-param-key="operation"]'),
  ).toContainText("constante");
});

test("editing the URL infers params live, amber for a changed geography (issue #491 EC-2)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();

  // Edit to a valid pisos.com search URL for a DIFFERENT municipality.
  await pisos.getByTestId("etl-url-input").fill("https://www.pisos.com/venta/pisos-malaga/");
  const panel = pisos.getByTestId("etl-inference-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Esta URL significa:");
  const inferred = pisos.locator('[data-testid="etl-inferred-chip"][data-param-key="geography"]');
  await expect(inferred).toContainText("malaga");
  // Differs from the profile-derived 'sevilla' → flagged amber.
  await expect(inferred).toHaveAttribute("data-differs", "true");
  await expect(pisos.getByTestId("etl-inference-warning")).toHaveCount(0);
  await assertNoErrorSurface(page);
});

test("unparseable URL saves verbatim with a warning (issue #491 EC-3)", async ({ page }) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();

  // A pisos.com search URL with an extra native-filter segment the grammar does
  // not model → unparseable; the page warns but does NOT block Guardar.
  await pisos.getByTestId("etl-url-input").fill(NEW_PISOS);
  await expect(pisos.getByTestId("etl-inference-warning")).toContainText(
    "se usará tal cual",
  );
  await expect(pisos.getByTestId("etl-inference-panel")).toHaveCount(0);
  await expect(pisos.getByTestId("etl-save")).toBeEnabled();

  // Host validation is intact and the verbatim URL persists.
  await pisos.getByTestId("etl-save").click();
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText("URL fijada");
  await expect(pisos.getByTestId("etl-url")).toHaveText(NEW_PISOS);
  await assertNoErrorSurface(page);

  await pool.query(
    "DELETE FROM profile_connector_filter WHERE profile_id = $1 AND connector = 'pisos'",
    [profileId],
  );
});

test("habitaclia: params chips + live inference + `?pag=2` verbatim (issue #492)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const habi = page.locator('[data-testid="etl-connector-row"][data-connector="habitaclia"]');
  await expect(habi).toBeVisible();
  await expect(habi).toHaveAttribute("data-tunable", "true");
  await expect(habi.getByTestId("etl-url")).toHaveText(HABITACLIA_PREVIEW_URL);

  // EC-1: geography (perfil) + operation (constante) chips.
  const geoChip = habi.locator('[data-testid="etl-param-chip"][data-param-key="geography"]');
  await expect(geoChip).toContainText("Municipio");
  await expect(geoChip).toContainText("sevilla");
  await expect(geoChip).toContainText("perfil");
  await expect(
    habi.locator('[data-testid="etl-param-chip"][data-param-key="operation"]'),
  ).toContainText("constante");

  // EC-2: editing to a valid habitaclia URL for a DIFFERENT municipality infers
  // the new municipality live (grammar-driven, no per-connector TS).
  await habi.getByTestId("etl-url-input").fill("https://www.habitaclia.com/viviendas-malaga.htm");
  const panel = habi.getByTestId("etl-inference-panel");
  await expect(panel).toBeVisible();
  const inferred = habi.locator('[data-testid="etl-inferred-chip"][data-param-key="geography"]');
  await expect(inferred).toContainText("malaga");
  await expect(inferred).toHaveAttribute("data-differs", "true");
  await expect(habi.getByTestId("etl-inference-warning")).toHaveCount(0);
  await assertNoErrorSurface(page);

  // EC-3: a `?pag=2` query is unparseable — robots disallows pagination — so the
  // page warns it will be used verbatim, but does NOT block Guardar.
  await habi.getByTestId("etl-url-input").fill("https://www.habitaclia.com/viviendas-sevilla.htm?pag=2");
  await expect(habi.getByTestId("etl-inference-warning")).toContainText("se usará tal cual");
  await expect(habi.getByTestId("etl-inference-panel")).toHaveCount(0);
  await expect(habi.getByTestId("etl-save")).toBeEnabled();
  await assertNoErrorSurface(page);
});

test("fotocasa: rooms params + live inference + query-string robots reject blocks Guardar (issue #493)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const foto = page.locator('[data-testid="etl-connector-row"][data-connector="fotocasa"]');
  await expect(foto).toBeVisible();
  await expect(foto).toHaveAttribute("data-tunable", "true");
  await expect(foto.getByTestId("etl-url")).toHaveText(FOTOCASA_PREVIEW_URL);

  // EC-1: geography (perfil) + operation (constante) + rooms (config, EXACTO).
  const geoChip = foto.locator('[data-testid="etl-param-chip"][data-param-key="geography"]');
  await expect(geoChip).toContainText("sevilla-capital");
  await expect(geoChip).toContainText("perfil");
  await expect(
    foto.locator('[data-testid="etl-param-chip"][data-param-key="operation"]'),
  ).toContainText("constante");
  const roomsChip = foto.locator('[data-testid="etl-param-chip"][data-param-key="rooms"]');
  await expect(roomsChip).toContainText("Habitaciones");
  await expect(roomsChip).toContainText("config");

  // EC-2: editing the URL to a different rooms token infers it live (the
  // -habitaciones segment round-trips through the grammar in the browser).
  await foto
    .getByTestId("etl-url-input")
    .fill(
      "https://www.fotocasa.es/es/comprar/viviendas/sevilla-capital/todas-las-zonas/3-habitaciones/l",
    );
  const panel = foto.getByTestId("etl-inference-panel");
  await expect(panel).toBeVisible();
  await expect(
    foto.locator('[data-testid="etl-inferred-chip"][data-param-key="rooms_segment"]'),
  ).toContainText("3-habitaciones");
  await expect(foto.getByTestId("etl-inference-rejected")).toHaveCount(0);
  await assertNoErrorSurface(page);

  // EC-3: a query string is a robots-forbidden shape — a HARD, reasoned block
  // (not a verbatim pin). The rejection message shows and Guardar is disabled.
  await foto
    .getByTestId("etl-url-input")
    .fill(
      "https://www.fotocasa.es/es/comprar/viviendas/sevilla-capital/todas-las-zonas/l?minPrice=100000",
    );
  const rejected = foto.getByTestId("etl-inference-rejected");
  await expect(rejected).toBeVisible();
  await expect(rejected).toHaveAttribute("data-reject-reason", "robots-query-params");
  await expect(rejected).toContainText("robots.txt");
  await expect(foto.getByTestId("etl-inference-panel")).toHaveCount(0);
  await expect(foto.getByTestId("etl-save")).toBeDisabled();
  await assertNoErrorSurface(page);
});

test("ETL section renders with no seeded previews — pending, no error surface (P4)", async ({
  page,
}) => {
  // Remove this profile's computed previews; the registered connectors still
  // render (LEFT JOIN) in a pending state, and there must be no error surface.
  await pool.query("DELETE FROM connector_search_preview WHERE profile_id = $1", [profileId]);
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("validar-filtros-etl-section")).toBeVisible();
  await assertNoErrorSurface(page);

  // pisos still appears (it's registered). Issue #513: with no ETL preview row
  // it is NO LONGER pending — its URL is derived on demand from the grammar +
  // the profile's province and labelled unverified (never URL-less).
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();
  await expect(pisos.getByTestId("etl-pending")).toHaveCount(0);
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText(
    "derivada (sin verificar por ETL)",
  );
  await expect(pisos.getByTestId("etl-url")).toHaveText(
    "https://www.pisos.com/venta/pisos-sevilla/",
  );

  // Restore for any later ordering.
  await seedEtlPreviews();
});

test("profile switcher on the filtros page navigates to the other profile's filtros page", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });

  const switcher = page.getByLabel("Cambiar de perfil de búsqueda");
  await expect(switcher).toBeVisible();
  // Starts on the current profile.
  await expect(switcher).toHaveValue(String(profileId));

  // Selecting the second profile keeps us on the filtros page (not the feed).
  await switcher.selectOption(String(profileId2));
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId2}/filtros`), { timeout: 30_000 });
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);
});

test("unicaja row shows the INE province chip and a dimmed non-consumed filter; editing infers it (issue #494)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const uni = page.locator('[data-testid="etl-connector-row"][data-connector="unicaja"]');
  await expect(uni).toBeVisible();
  await expect(uni).toHaveAttribute("data-tunable", "true");
  // Provincia resolved to a legible "INE 29 · Málaga" chip (consumed).
  const prov = uni.locator('[data-testid="etl-param-chip"][data-param-key="provincia"]');
  await expect(prov).toContainText("INE 29 · Málaga");
  await expect(prov).toHaveAttribute("data-consumed", "true");
  // A native filter present in the URL but NOT consumed yet is dimmed + labelled.
  const price = uni.locator('[data-testid="etl-param-chip"][data-param-key="precioMax"]');
  await expect(price).toHaveAttribute("data-consumed", "false");
  await expect(price).toContainText(/no consumido aún/i);

  // Editing precioMax into the URL infers it, still flagged non-consumed.
  await uni
    .getByTestId("etl-url-input")
    .fill(UNICAJA_PREVIEW_URL.replace("precioMax=", "precioMax=200000"));
  const inferred = uni.locator('[data-testid="etl-inferred-chip"][data-param-key="precioMax"]');
  await expect(inferred).toContainText("200000");
  await expect(inferred).toHaveAttribute("data-consumed", "false");
  await assertNoErrorSurface(page);
});

test("servihabitat row rejects a faceted-search URL with the robots reason (issue #495)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });

  const servi = page.locator('[data-testid="etl-connector-row"][data-connector="servihabitat"]');
  await expect(servi).toBeVisible();
  await expect(servi.getByTestId("etl-url")).toHaveText(SERVIHABITAT_PREVIEW_URL);
  // A faceted-search URL (query string) is a HARD reasoned block: Guardar off.
  await servi
    .getByTestId("etl-url-input")
    .fill("https://www.servihabitat.com/es/venta/viviendas/sevilla?precio=0-200000");
  const rejected = servi.getByTestId("etl-inference-rejected");
  await expect(rejected).toHaveAttribute("data-reject-reason", "robots-faceted-search");
  await expect(rejected).toContainText(/facetada|robots/i);
  await expect(servi.getByTestId("etl-save")).toBeDisabled();
  await assertNoErrorSurface(page);
});

test("empty url opens the portal home — altamira capture row, validate-tagged (issue #515 EC-1)", async ({
  page,
}) => {
  // Ensure altamira has no pin so its row is the empty (no derived URL) case.
  await pool.query(
    "DELETE FROM profile_connector_filter WHERE profile_id = $1 AND connector = 'altamira'",
    [profileId],
  );
  // Capture window.open args deterministically instead of spawning a real popup.
  await page.addInitScript(() => {
    (window as unknown as { __opened: unknown[][] }).__opened = [];
    window.open = ((...args: unknown[]) => {
      (window as unknown as { __opened: unknown[][] }).__opened.push(args);
      return null;
    }) as typeof window.open;
  });
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const altaRow = page.locator('[data-testid="filter-validation-row"][data-connector="altamira"]');
  await expect(altaRow).toBeVisible();
  // No derived URL → the "Abrir" button is the enabled portal-home fallback.
  await expect(altaRow.getByTestId("filter-no-url")).toBeVisible();
  const open = altaRow.getByTestId("filter-open");
  await expect(open).toBeEnabled();
  await expect(open).toHaveText(/Abrir portal/);

  await open.click();
  const opened = await page.evaluate(
    () => (window as unknown as { __opened: unknown[][] }).__opened,
  );
  expect(opened.length).toBe(1);
  const openedUrl = opened[0][0] as string;
  // Opens the altamira portal home, tagged for validation (capture-free).
  expect(openedUrl).toContain("altamirainmuebles.com");
  expect(openedUrl).toContain("#inmo-validate=");
  await assertNoErrorSurface(page);
});

test("etl row home fallback — a non-tunable connector opens its portal home (issue #515 EC-2)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await pool.query(
    "UPDATE connector_registry SET home_url = 'https://www.escogecasa.es' WHERE connector_name = 'escogecasa'",
  );
  await page.addInitScript(() => {
    (window as unknown as { __opened: unknown[][] }).__opened = [];
    window.open = ((...args: unknown[]) => {
      (window as unknown as { __opened: unknown[][] }).__opened.push(args);
      return null;
    }) as typeof window.open;
  });
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  const esc = page.locator('[data-testid="etl-connector-row"][data-connector="escogecasa"]');
  await expect(esc).toBeVisible();
  await expect(esc).toHaveAttribute("data-tunable", "false");
  // Non-tunable rows expose an "Abrir portal" button that opens the browseable
  // home page (their preview URL is a machine endpoint), so the row is never dead.
  const open = esc.getByTestId("etl-open");
  await expect(open).toHaveText(/Abrir portal/);
  await open.click();
  const opened = await page.evaluate(
    () => (window as unknown as { __opened: unknown[][] }).__opened,
  );
  expect(opened.length).toBe(1);
  expect(opened[0][0]).toBe("https://www.escogecasa.es");
  await assertNoErrorSurface(page);
});

test("non-tunable escogecasa row shows its real params (bbox, centro, radio) and no URL to save (issue #496)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });

  const esc = page.locator('[data-testid="etl-connector-row"][data-connector="escogecasa"]');
  await expect(esc).toBeVisible();
  await expect(esc).toHaveAttribute("data-tunable", "false");
  // The real params governing recall are shown instead of only a note.
  await expect(esc.locator('[data-testid="etl-param-chip"][data-param-key="bbox"]')).toContainText(
    "37.118830",
  );
  await expect(esc.locator('[data-testid="etl-param-chip"][data-param-key="centro"]')).toBeVisible();
  await expect(esc.locator('[data-testid="etl-param-chip"][data-param-key="radio_km"]')).toContainText(
    "30 km",
  );
  // Honestly non-tunable: no editable URL, read-only note present.
  await expect(esc.getByTestId("etl-readonly")).toBeVisible();
  await expect(esc.getByTestId("etl-url-input")).toHaveCount(0);
  await assertNoErrorSurface(page);
});
