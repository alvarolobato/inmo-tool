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
 * The fixture below is SYNTHETIC and reproduces the load-bearing shape of
 * capture id 3576: `<main>`, an `<h1>` carrying the result count, an
 * `init-front-list`, four painted `init-similar-card`s and thirteen standalone
 * `p-skeleton` placeholders — 4 + 13 = the 17 the owner could see. No scraped
 * listing content: every title, price and location here is invented.
 *
 * Two details of the real DOM that the fixture MUST keep, because getting
 * either wrong makes the suite agree with a bug:
 *
 *   * Each painted card carries a `<p-skeleton>` OF ITS OWN — the photo
 *     carousel's slot (offsets 172248 / 185275 / 198174 / 211214 in id 3576,
 *     each inside a card's range). So the raw tag count on that capture is
 *     SEVENTEEN, not thirteen, and a fully painted page carries seventeen too.
 *     A fixture whose cards had no skeleton would let the suite assert a
 *     zero-placeholder end state the portal never reaches.
 *   * All FOUR asset references are the real triples read off id 3576's CDN
 *     paths, so the cross-check against a known-good production capture stays
 *     honest. They are opaque public servicer codes carrying no personal data.
 *     Note the lot segment is NOT 1:1 with the reference — `rran01399` hosts
 *     rare-01643, rare-03256 AND rare-04347 — so only the third segment is
 *     the id, which is what mediaDetailRef takes.
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
  expectedResultCount,
  mediaHarvestStats,
  detailPortalForUrl,
  maxWaitMsFor,
  readySelectorsFor,
  DEFAULT_MAX_WAIT_MS,
} = D as any;

const SEARCH_URL =
  "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla";

/**
 * One PAINTED result card: real title/m²/price, a photo whose CDN path carries
 * the asset ref, and NO anchor of any kind — that last part is the whole bug.
 *
 * It carries its own `<p-skeleton>`, inside the card, exactly as every painted
 * card in id 3576 does: PrimeNG holds the photo-carousel slot with one while
 * the image loads. This card HAS painted; only its picture is still arriving.
 */
function card(bucket: string, lot: string, ref: string, label: string): string {
  return `
    <init-similar-card class="ng-star-inserted"><p-card><div class="flex flex-col">
      <div class="overflow-hidden rounded-t-hp h-[210px] relative">
        <p-skeleton class="!absolute inset-0 w-full p-component p-skeleton"
                    aria-hidden="true" style="height: 210px;"></p-skeleton>
        <img loading="lazy" alt="foto"
             src="https://hipoges.azureedge.net/imageshams/${bucket}/${lot}/${ref}/44680767_abc.png">
      </div>
      <span>${label}</span><span>00 m²</span><span>0 Habs.</span><span>0 €</span>
    </div></p-card></init-similar-card>`;
}

/**
 * A result that has NOT painted: PrimeNG's standalone placeholder in its
 * `<div class="item">` wrapper, exactly as id 3576 carried thirteen of them.
 * Note it sits OUTSIDE any card — that is what distinguishes it from the
 * in-card skeleton above, and it is the distinction the placeholder count
 * turns on.
 */
const SKELETON = `<div class="item ng-star-inserted"><p-skeleton width="100%" height="378px"
  aria-hidden="true" class="p-component p-skeleton"></p-skeleton></div>`;

/** SKELETON as a regex source, for the one test that strips the pending ones out. */
const SKELETON_RE = SKELETON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The four real (bucket, lot, ref) triples read off capture id 3576's CDN paths. */
const REAL_CARDS: Array<[string, string, string]> = [
  ["hams_es_frankel", "rfra02005", "frre-20005"],
  ["hams_es_frankel", "rfra02169", "frre-20171"],
  ["hams_es_galapagos", "bgal3100", "rega-06247"],
  ["hams_es_gentauro", "rgnt0774", "gtre-01142"],
];

/** The search page with `painted` of its 17 results rendered and the rest skeletons. */
function searchPage(painted: number): string {
  const cards: string[] = [];
  for (let i = 0; i < painted; i++) {
    // The first four reuse the real triples (the CDN cross-check depends on
    // them); any beyond that are invented refs of the same shape, which is all
    // the count-based assertions need.
    const [bucket, lot, ref] =
      REAL_CARDS[i] ?? ["hams_es_frankel", `rfra0${3000 + i}`, `frre-3${1000 + i}`];
    cards.push(card(bucket, lot, ref, `Vivienda de ejemplo ${i + 1}`));
  }
  return `
    <main>
      <init-navbar><span>Sobre Hipoges Blog Comprar Invertir Subastas y CDR</span></init-navbar>
      <init-front-list class="ng-star-inserted">
        <aside><form>Tu búsqueda: tipo, situación, tamaño, precio, habitaciones, baños,
          características, balcón, piscina, garaje, gimnasio, alarma, terraza, jardín.</form></aside>
        <h1>17 Pisos y casas en venta en Dos Hermanas, Sevilla</h1>
        <span>Ordenar por: Relevancia Recientes Baratos Mapa</span>
        ${cards.join("")}
        ${SKELETON.repeat(TOTAL_RESULTS - painted)}
      </init-front-list>
      <init-footer><span>Aviso legal, privacidad, cookies, trabaja con nosotros.</span></init-footer>
    </main>`;
}

/** The count the page's own `<h1>` states, and the number of items its list holds. */
const TOTAL_RESULTS = 17;

/**
 * The page as capture id 3576 actually stood: header and filters fully
 * rendered, four results painted, thirteen still skeletons.
 */
function searchPagePartiallyPainted(): string {
  return searchPage(4);
}

/**
 * The real end state: all 17 results painted, no standalone placeholder left.
 *
 * Built by painting the remaining cards, NOT by deleting skeletons — each
 * painted card brings its own in-card skeleton with it, so this page still
 * carries seventeen `<p-skeleton>` tags, exactly as the live portal does.
 */
function searchPageFullyPainted(): string {
  return searchPage(TOTAL_RESULTS);
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

  it("counts results that have not arrived, NOT every skeleton on the page", () => {
    // The trap this pins: id 3576 carries SEVENTEEN <p-skeleton> tags, because
    // each of the four painted cards holds one for its own photo carousel. Only
    // the thirteen standalone ones are results still to come, and a fully
    // painted page — which still has seventeen tags, one per card — has none.
    const partial = setBody(searchPagePartiallyPainted());
    expect(partial.querySelectorAll("p-skeleton")).toHaveLength(17);
    expect(partial.querySelectorAll("init-similar-card")).toHaveLength(4);
    expect(pendingPlaceholderCount(partial, "hipoges")).toBe(13);

    const full = setBody(searchPageFullyPainted());
    expect(full.querySelectorAll("init-similar-card")).toHaveLength(17);
    // Not zero tags — zero PENDING RESULTS. This is the distinction that makes
    // the reported `pendingPlaceholders` mean anything.
    expect(full.querySelectorAll("p-skeleton")).toHaveLength(17);
    expect(pendingPlaceholderCount(full, "hipoges")).toBe(0);
  });

  it("reports 'still_loading' while results are genuinely missing", () => {
    const doc = setBody(searchPagePartiallyPainted());
    expect(isRenderReadyListing(doc, "hipoges", SEARCH_URL, null).reason).toBe("still_loading");
  });

  it("does NOT say 'still_loading' on a fully painted page", () => {
    // The operational point of the whole placeholder fix. `reason` is what
    // describeNeverRendered writes into error_msg as `motivo=` and what
    // diagnostic.js reports; if the in-card skeletons were counted it would
    // read "still_loading" forever, including on a page that had finished —
    // the one signal added for diagnosis would be wrong exactly when consulted.
    const doc = setBody(searchPageFullyPainted());
    const first = isRenderReadyListing(doc, "hipoges", SEARCH_URL, null);
    expect(first.ready).toBe(false); // not settled yet — but honest about why
    expect(first.reason).toBe("not_settled");
    expect(first.placeholders).toBe(0);
  });

  it("becomes ready once every stated result has been harvested", () => {
    const doc = setBody(searchPageFullyPainted());
    const v = pollListing(doc, SEARCH_URL, 3);
    expect(v.ready).toBe(true);
    expect(v.detailUrls.length).toBe(17);
    expect(v.expected).toBe(17);
  });

  it("does not fire on the FIRST non-zero harvest of a progressively painting list", () => {
    // Hipoges paints results in batches. Firing on the first non-empty harvest
    // would capture a fraction of the search and silently drop the rest.
    const doc = setBody(searchPagePartiallyPainted());
    expect(isRenderReadyListing(doc, "hipoges", SEARCH_URL, null).ready).toBe(false);
    expect(pollListing(doc, SEARCH_URL, 2).ready).toBe(false);
  });
});

describe("Hipoges: a settled count is not the same as a complete one", () => {
  it("reads the search total off the page's own heading", () => {
    expect(expectedResultCount(setBody(searchPagePartiallyPainted()), "hipoges")).toBe(17);
  });

  it("refuses to call a mid-paint stall 'ready', however long the count holds", () => {
    // THE bug this closes. harvestSettlePolls(3) x 500ms is 1.5s of an
    // unchanged count; a slow connection stalling mid-paint satisfies that at
    // 9 of 17, and the old gate would autostart the capture on those 9 as a
    // SUCCESS — not as a deadline fallback. The page states 17; we have 9;
    // eight results are still visibly pending. That is not ready.
    const doc = setBody(searchPage(9));
    const v = pollListing(doc, SEARCH_URL, 12); // far past the settle window
    expect(v.ready).toBe(false);
    expect(v.reason).toBe("partial_harvest");
    expect(v.detailUrls.length).toBe(9);
    expect(v.expected).toBe(17);
    expect(v.placeholders).toBe(8);
  });

  it("falls back to the settle window when the page states no readable total", () => {
    // Route (c): no number to compare against, so "has it stopped changing" is
    // the only question available — the pre-existing behaviour, unchanged, and
    // what every portal other than Hipoges gets.
    const doc = setBody(
      searchPage(9).replace(
        /<h1>[^<]*<\/h1>/,
        "<h1>Pisos y casas en venta en Dos Hermanas, Sevilla</h1>",
      ),
    );
    expect(expectedResultCount(doc, "hipoges")).toBeNull();
    const v = pollListing(doc, SEARCH_URL, 3);
    expect(v.ready).toBe(true);
    expect(v.detailUrls.length).toBe(9);
  });

  it("releases when the list says nothing more is coming, even short of the total", () => {
    // Route (b), the anti-stall valve: a stated total this view will never
    // reach (a paginated search would look like this) must not hold the page
    // to its 45s deadline when the list itself has no pending result left.
    const doc = setBody(searchPage(9).replace(new RegExp(SKELETON_RE, "g"), ""));
    expect(pendingPlaceholderCount(doc, "hipoges")).toBe(0);
    expect(expectedResultCount(doc, "hipoges")).toBe(17);
    const v = pollListing(doc, SEARCH_URL, 3);
    expect(v.ready).toBe(true);
    expect(v.detailUrls.length).toBe(9);
  });

  it("ignores a heading that does not open with a number", () => {
    const doc = setBody(`<main><init-front-list><h1>Resultados de tu búsqueda: 17</h1></init-front-list></main>`);
    expect(expectedResultCount(doc, "hipoges")).toBeNull();
  });
});

describe("Hipoges: a CDN rule that stops matching must not look like a page that never rendered", () => {
  it("counts media on the portal's own CDN whose path yields no reference", () => {
    // issue #701 review L1. A five-letter servicer prefix, or a CDN
    // restructure, yields zero refs while the page is perfectly healthy.
    const stats = mediaHarvestStats(
      [
        "https://hipoges.azureedge.net/imageshams/hams_es_new/rnew01/nuevo-99999/a.png",
        "https://hipoges.azureedge.net/imageshams/hams_es_new/rnew02/otroref/b.png",
        "https://example.com/imageshams/a/b/frre-20005/x.png", // not our CDN: not counted
      ],
      SEARCH_URL,
      "hipoges",
    );
    expect(stats.urls).toEqual([]);
    expect(stats.hostMatched).toBe(2);
    expect(stats.refMisses).toBe(2);
  });

  it("says so in the verdict instead of reporting 'no detail urls'", () => {
    const doc = setBody(`
      <main><init-front-list><h1>17 Pisos y casas en venta en Dos Hermanas, Sevilla</h1>
        <init-similar-card><img src="https://hipoges.azureedge.net/imageshams/b/l/nuevo-99999/a.png">
        </init-similar-card>
      </init-front-list></main>`);
    const v = isRenderReadyListing(doc, "hipoges", SEARCH_URL, null);
    expect(v.detailUrls).toEqual([]);
    expect(v.refMisses).toBe(1);
    // NOT "no_detail_urls" — that would be indistinguishable from a page that
    // genuinely never painted, the exact conflation #701 exists to end.
    expect(v.reason).toBe("ref_shape_unmatched");
  });

  it("reports zero misses on a healthy page", () => {
    const v = isRenderReadyListing(setBody(searchPagePartiallyPainted()), "hipoges", SEARCH_URL, null);
    expect(v.refMisses).toBe(0);
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
