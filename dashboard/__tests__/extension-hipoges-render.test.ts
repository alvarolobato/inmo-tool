// @vitest-environment jsdom
/**
 * Hipoges render-readiness and detail-URL harvesting (issue #701).
 *
 * The owner reported Hipoges twice — "no está detectando los listados", and
 * then, concretely, "/es/venta/… dice que no hay anuncios que capturar y yo
 * veo 17". Production held two active Hipoges listings. These tests pin the
 * three distinct defects behind that, each one established from HTML already
 * stored in production Postgres (`extension_capture` ids 3576 / 3577 / 3614-
 * 3617), never by fetching the site — Hipoges is capture-only (D-075/D-111).
 *
 *   1. readySelectors were `["main","h1"]`, which the page furniture satisfies
 *      on the first poll while every advert is still a skeleton;
 *   2. Hipoges result cards carry NO `<a href>` at all, so the anchor harvest
 *      returns zero on a perfectly rendered search page — no amount of waiting
 *      would ever have fixed that one;
 *   3. `es/blog/detail/<slug>` classified as a listing-detail page.
 *
 * The fixture below is SYNTHETIC and reproduces only the load-bearing shape of
 * capture id 3576: `<main>`, an `<h1>` carrying the result count, an
 * `init-front-list`, four painted `init-similar-card`s and thirteen
 * `p-skeleton` placeholders — 4 + 13 = the 17 the owner could see. No scraped
 * listing content: every title, price and location here is invented. The photo
 * CDN paths keep the real shape because that path IS the thing under test, and
 * two of the four asset references are the real ones so the cross-check below
 * against a known-good production capture stays honest; they are opaque
 * servicer codes carrying no personal data.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/detect.js";

const D = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const {
  isRenderReadyDetail,
  isRenderReadyListing,
  harvestDetailUrls,
  detailUrlsFromMedia,
  pendingPlaceholderCount,
  detailPortalForUrl,
  maxWaitMsFor,
  readySelectorsFor,
  DEFAULT_MAX_WAIT_MS,
} = D as any;

const SEARCH_URL =
  "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla";

/** One painted result card: a photo whose CDN path carries the asset ref, no anchor. */
function card(bucket: string, lot: string, ref: string, label: string): string {
  return `
    <init-similar-card class="ng-star-inserted"><p-card><div class="flex flex-col">
      <img loading="lazy" alt="foto"
           src="https://hipoges.azureedge.net/imageshams/${bucket}/${lot}/${ref}/44680767_abc.png">
      <span>${label}</span><span>00 m²</span><span>0 Habs.</span><span>0 €</span>
    </div></p-card></init-similar-card>`;
}

/** A not-yet-painted result: PrimeNG's loading placeholder, exactly as id 3576 carried it. */
const SKELETON = `<div class="item ng-star-inserted"><p-skeleton width="100%" height="378px"
  aria-hidden="true" class="p-component p-skeleton"></p-skeleton></div>`;

/**
 * The page as capture id 3576 actually stood: header and filters fully
 * rendered, four results painted, thirteen still skeletons.
 */
function searchPagePartiallyPainted(): string {
  return `
    <main>
      <init-navbar><span>Sobre Hipoges Blog Comprar Invertir Subastas y CDR</span></init-navbar>
      <init-front-list class="ng-star-inserted">
        <aside><form>Tu búsqueda: tipo, situación, tamaño, precio, habitaciones, baños,
          características, balcón, piscina, garaje, gimnasio, alarma, terraza, jardín.</form></aside>
        <h1>17 Pisos y casas en venta en Dos Hermanas, Sevilla</h1>
        <span>Ordenar por: Relevancia Recientes Baratos Mapa</span>
        ${card("hams_es_frankel", "rfra02005", "frre-20005", "Vivienda de ejemplo A")}
        ${card("hams_es_frankel", "rfra02169", "frre-20171", "Vivienda de ejemplo B")}
        ${card("hams_es_galapagos", "bgal3100", "rega-06247", "Vivienda de ejemplo C")}
        ${card("hams_es_gentauro", "rgnt0774", "gtre-01142", "Vivienda de ejemplo D")}
        ${SKELETON.repeat(13)}
      </init-front-list>
      <init-footer><span>Aviso legal, privacidad, cookies, trabaja con nosotros.</span></init-footer>
    </main>`;
}

/** The same page once every result has painted and no placeholder is left. */
function searchPageFullyPainted(): string {
  return searchPagePartiallyPainted().replace(new RegExp(SKELETON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
}

function setBody(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

/** Drive isRenderReadyListing the way content-script.js does: poll, threading state. */
function pollListing(doc: Document, url: string, polls: number) {
  let state: unknown = null;
  let last: any = null;
  for (let i = 0; i < polls; i++) {
    last = isRenderReadyListing(doc, "hipoges", url, state);
    state = last.state;
  }
  return last;
}

describe("Hipoges: a results page is not ready while its adverts are still skeletons", () => {
  it("does not report ready on the first poll, the way ['main','h1'] did", () => {
    const doc = setBody(searchPagePartiallyPainted());
    const first = isRenderReadyListing(doc, "hipoges", SEARCH_URL, null);
    expect(first.ready).toBe(false);
    // The precise regression: `main` and `h1` are BOTH present and the body is
    // far past the 400-char floor, so the old readiness check said yes here.
    expect(doc.querySelector("main")).not.toBeNull();
    expect(doc.querySelector("h1")!.textContent).toContain("17");
    expect((doc.body.textContent || "").trim().length).toBeGreaterThan(400);
  });

  it("counts the unpainted results as loading placeholders", () => {
    const doc = setBody(searchPagePartiallyPainted());
    expect(pendingPlaceholderCount(doc, "hipoges")).toBe(13);
    expect(pendingPlaceholderCount(setBody(searchPageFullyPainted()), "hipoges")).toBe(0);
  });

  it("reports 'still_loading', not 'no detail urls', while placeholders remain", () => {
    const doc = setBody(searchPagePartiallyPainted());
    expect(isRenderReadyListing(doc, "hipoges", SEARCH_URL, null).reason).toBe("still_loading");
  });

  it("becomes ready once the harvested count has settled, and never deadlocks", () => {
    // A static page cannot keep growing, so after the settle window it must
    // resolve rather than hang — a partial harvest beats the zero the owner got.
    const doc = setBody(searchPagePartiallyPainted());
    const v = pollListing(doc, SEARCH_URL, 3);
    expect(v.ready).toBe(true);
    expect(v.detailUrls.length).toBe(4);
  });

  it("does not fire on the FIRST non-zero harvest of a progressively painting list", () => {
    // Hipoges paints results in batches. Firing on the first non-empty harvest
    // would capture a fraction of the search and silently drop the rest.
    const doc = setBody(searchPagePartiallyPainted());
    expect(isRenderReadyListing(doc, "hipoges", SEARCH_URL, null).ready).toBe(false);
    expect(pollListing(doc, SEARCH_URL, 2).ready).toBe(false);
  });
});

describe("Hipoges: detail URLs come off the photo CDN, because the cards are not links", () => {
  it("the rendered cards genuinely carry no anchor at all", () => {
    const doc = setBody(searchPagePartiallyPainted());
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    expect(anchors.filter((a) => detailPortalForUrl((a as HTMLAnchorElement).href))).toHaveLength(0);
  });

  it("recovers the asset reference from the CDN path and builds the detail URL", () => {
    const doc = setBody(searchPagePartiallyPainted());
    expect(harvestDetailUrls(doc, "hipoges", SEARCH_URL)).toEqual([
      "https://realestate.hipoges.com/es/detail/FRRE-20005",
      "https://realestate.hipoges.com/es/detail/FRRE-20171",
      "https://realestate.hipoges.com/es/detail/REGA-06247",
      "https://realestate.hipoges.com/es/detail/GTRE-01142",
    ]);
  });

  it("the derived URL is one this portal recognises as a detail page", () => {
    // The cross-check that makes the rule trustworthy rather than plausible:
    // FRRE-20005 derived this way is already in production as a SUCCESSFULLY
    // captured detail page (extension_capture rows 3623/3696).
    const url = harvestDetailUrls(setBody(searchPagePartiallyPainted()), "hipoges", SEARCH_URL)[0];
    expect(url).toBe("https://realestate.hipoges.com/es/detail/FRRE-20005");
    expect(detailPortalForUrl(url)).toBe("hipoges");
  });

  it("builds the URL in the language the operator is browsing, not a hard-coded 'es'", () => {
    const doc = setBody(searchPagePartiallyPainted());
    const pt = "https://realestate.hipoges.com/pt/venta/pisos-y-casas/espana/dos-hermanas_sevilla";
    expect(harvestDetailUrls(doc, "hipoges", pt)[0]).toBe(
      "https://realestate.hipoges.com/pt/detail/FRRE-20005",
    );
  });

  it("ignores media that is not a Hipoges asset photo", () => {
    const srcs = [
      "https://example.com/imageshams/a/b/frre-20005/x.png", // wrong host
      "https://hipoges.azureedge.net/assets/icons/camera.webp", // not an asset path
      "https://hipoges.azureedge.net/imageshams/a/b/not-a-ref/x.png", // ref shape fails
    ];
    expect(detailUrlsFromMedia(srcs, SEARCH_URL, "hipoges")).toEqual([]);
  });

  it("is inert for every other portal", () => {
    expect(
      detailUrlsFromMedia(
        ["https://hipoges.azureedge.net/imageshams/a/b/frre-20005/x.png"],
        "https://www.idealista.com/venta-viviendas/madrid-madrid/",
        "idealista",
      ),
    ).toEqual([]);
  });
});

describe("Hipoges: an empty shell is never a ready DETAIL page", () => {
  it("rejects the shell even when main/h1 are present and the body is huge", () => {
    // This is what produced rows 3614-3617 at 3 of 26 fields.
    const doc = setBody(searchPagePartiallyPainted());
    const v = isRenderReadyDetail(doc, "hipoges");
    expect(v.ready).toBe(false);
    expect(v.reason).toBe("no_key_node");
    expect(v.bodyTextLength).toBeGreaterThan(400);
  });

  it("accepts a page carrying the real advert component elements", () => {
    const doc = setBody(`
      <main><init-asset-detail-main-info><h1>Piso de ejemplo</h1>
        <span>Referencia: TEST-00001</span></init-asset-detail-main-info>
      <init-asset-detail-description><p>${"Texto de descripción de ejemplo. ".repeat(20)}</p>
      </init-asset-detail-description></main>`);
    const v = isRenderReadyDetail(doc, "hipoges");
    expect(v.ready).toBe(true);
    expect(v.selector).toBe("init-asset-detail-main-info");
  });

  it("has dropped the generic main/h1 fallback for this portal only", () => {
    expect(readySelectorsFor("hipoges", "detail")).not.toContain("main");
    expect(readySelectorsFor("hipoges", "detail")).not.toContain("h1");
    expect(readySelectorsFor("idealista", "detail")).toContain("main");
  });
});

describe("Hipoges: blog articles are not adverts", () => {
  it("does not classify es/blog/detail/<slug> as a listing detail page", () => {
    // Six of these are linked from the Hipoges home page (production capture
    // id 3577); the ':investment' wildcard was swallowing 'blog'.
    expect(
      detailPortalForUrl(
        "https://realestate.hipoges.com/es/blog/detail/pisos-en-alcala-de-henares-oportunidades",
      ),
    ).toBeNull();
  });

  it("still recognises the real detail shapes it must not break", () => {
    for (const u of [
      "https://realestate.hipoges.com/es/detail/RARE-04347",
      "https://realestate.hipoges.com/es/npl/detail/ABC-123",
      "https://realestate.hipoges.com/es/detail/12345/unavailable",
    ]) {
      expect(detailPortalForUrl(u)).toBe("hipoges");
    }
  });
});

describe("Dropping the generic fallback must not make block detection trigger-happy", () => {
  it("a healthy Hipoges results page is not called blocked just because it mentions a challenge phrase", () => {
    // D-142 vetoes a block verdict when the page rendered its real content,
    // and that veto used to ride on the generic main/h1 readiness. Removing
    // that fallback for Hipoges (#701) would otherwise leave a results page
    // permanently "not rendered", so any stray phrase could pause a batch run.
    const doc = setBody(
      searchPagePartiallyPainted() +
        `<p>Verifica que eres humano antes de continuar. Comprueba la conexión de tu sitio.</p>`,
    );
    const { detectBlockSignals } = D as any;
    expect(detectBlockSignals(doc, "hipoges", SEARCH_URL).blocked).toBe(false);
  });

  it("but a Hipoges page with NO adverts on it is still eligible to be called blocked", () => {
    const doc = setBody(
      `<main><p>Verifica que eres humano. Comprueba la conexión de tu sitio antes de continuar.</p></main>`,
    );
    const { pageRenderedRealContent } = D as any;
    expect(pageRenderedRealContent(doc, "hipoges", SEARCH_URL)).toBe(false);
  });
});

describe("Render budget is per portal", () => {
  it("gives Hipoges its own budget without slowing every other portal down", () => {
    expect(maxWaitMsFor("hipoges")).toBe(45000);
    expect(maxWaitMsFor("idealista")).toBe(DEFAULT_MAX_WAIT_MS);
    expect(maxWaitMsFor("unknown-portal")).toBe(DEFAULT_MAX_WAIT_MS);
  });
});
