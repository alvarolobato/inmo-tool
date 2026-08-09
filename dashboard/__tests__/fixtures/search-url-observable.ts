/**
 * Shared fixture for the passive search-URL OBSERVER gate (issue #510).
 *
 * Pins the extension helper (browser-extension/observe-search-url.js) and its
 * dashboard mirror (dashboard/lib/observed-search-url.ts) to identical verdicts:
 * for each URL, the capture portal it is an OBSERVABLE search page for, or null
 * when it isn't observable (home/detail/unsupported-host/bad-scheme).
 *
 * Both `dashboard/__tests__/extension-observe-search-url.test.ts` and
 * `dashboard/lib/__tests__/observed-search-url.test.ts` iterate this table, so a
 * drift between server and extension fails a test.
 */

export interface ObservableCase {
  url: string;
  /** Expected observable portal, or null when NOT an observable search URL. */
  portal: string | null;
  desc: string;
}

export const OBSERVABLE_CASES: readonly ObservableCase[] = [
  // ── idealista: unchanged pre-#510 predicate ──────────────────────────────
  {
    url: "https://www.idealista.com/venta-viviendas/estepona-malaga/",
    portal: "idealista",
    desc: "idealista listado (venta)",
  },
  {
    url: "https://idealista.com/alquiler-viviendas/malaga/",
    portal: "idealista",
    desc: "idealista listado (alquiler)",
  },
  {
    url: "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29",
    portal: "idealista",
    desc: "idealista areas + shape",
  },
  {
    url: "https://www.idealista.com/multi/venta-viviendas/madrid/",
    portal: "idealista",
    desc: "idealista multi",
  },
  {
    url: "https://www.idealista.com/venta-locales/?shape=xyz",
    portal: "idealista",
    desc: "idealista shape param",
  },
  { url: "https://www.idealista.com/", portal: null, desc: "idealista home" },
  {
    url: "https://www.idealista.com/inmueble/106387165/",
    portal: null,
    desc: "idealista detail",
  },

  // ── aliseda: /comprar…/alquilar…/alquiler… result roots ───────────────────
  {
    url: "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga",
    portal: "aliseda",
    desc: "aliseda comprar-viviendas",
  },
  {
    url: "https://alisedainmobiliaria.com/alquiler-viviendas/",
    portal: "aliseda",
    desc: "aliseda alquiler-viviendas",
  },
  {
    url: "https://www.alisedainmobiliaria.com/comprar",
    portal: "aliseda",
    desc: "aliseda bare comprar root",
  },
  {
    url: "https://www.alisedainmobiliaria.com/inmueble/ANT1",
    portal: null,
    desc: "aliseda detail (not a result root)",
  },
  {
    url: "https://www.alisedainmobiliaria.com/",
    portal: null,
    desc: "aliseda home",
  },

  // ── altamira: permissive — any non-detail, non-home path (#510) ────────────
  {
    url: "https://www.altamirainmuebles.com/venta-viviendas/pontevedra/",
    portal: "altamira",
    desc: "altamira listado",
  },
  {
    url: "https://altamirainmuebles.com/resultados?zona=pontevedra",
    portal: "altamira",
    desc: "altamira arbitrary non-detail path (permissive)",
  },
  {
    url: "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
    portal: null,
    desc: "altamira detail",
  },
  {
    url: "https://www.altamirainmuebles.com/",
    portal: null,
    desc: "altamira home",
  },

  // ── rejects across the board ──────────────────────────────────────────────
  {
    url: "https://example.com/venta-viviendas/",
    portal: null,
    desc: "non-portal host",
  },
  {
    url: "https://idealista.com.evil.example/venta-viviendas/",
    portal: null,
    desc: "look-alike host",
  },
  {
    url: "javascript://idealista.com/venta-viviendas/",
    portal: null,
    desc: "non-http(s) scheme",
  },
  { url: "not a url", portal: null, desc: "unparseable" },
  { url: "", portal: null, desc: "empty string" },
];
