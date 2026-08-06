---
id: D-019
title: Aliseda not buildable — real listing data served only from a robots.txt-disallowed API host
date: 2026-08-04
group: Data / connectors
rule: 'Aliseda (`alisedainmobiliaria.com`) not buildable: every page is a contentless JS shell; the real data API (`laravel.alisedainmobiliaria.com`) declares `Disallow: /` for all crawlers. No connector written.'
order: 29
---

# D-019: Aliseda not buildable — real listing data served only from a robots.txt-disallowed API host

*Decided: 2026-08-04*

**Context**: Issue #123, ranked #1 in #132's Andalucía-first build order on
the strength of a "correction" comment that fixed the domain
(`aliseda.es` — corporate/institutional, dead-end Liferay portlet — to
`www.alisedainmobiliaria.com`, the real consumer portal) and found a
clean, permissive `robots.txt` plus 3 declared sitemaps at the `www` host.
That correction was right as far as it went, but it never verified that
the pages it pointed at actually carry listing data over plain HTTP — it
inferred crawlability from "sitemap-driven + permissive robots.txt", the
Servihabitat/Vivantial shape, without fetching a real page.

**Findings, live-verified 2026-08-04, honestly identified UA, requests
seconds apart**:

1. `https://www.alisedainmobiliaria.com/robots.txt` — confirmed permissive
   as the correction comment described: disallows only account/auth paths
   and ad-tracking query params, declares
   `sitemap-index-aliseda.xml` (→ `sitemap-inmuebles-aliseda-es-0.xml`,
   **5,845** `/inmueble/<id>` detail URLs nationally) plus
   `sitemap-loans.xml`/`sitemap-investors.xml`.
2. `sitemap-category-aliseda-es-0.xml` additionally publishes a
   `/comprar-viviendas/<comunidad>/<provincia>/<municipio>` search-page
   partition down to municipality level (confirmed for both Málaga —
   estepona, marbella, mijas, fuengirola, benahavis, málaga capital — and
   Sevilla — sevilla capital, dos-hermanas, mairena-del-aljarafe, utrera,
   etc.) — exactly the "published partition beats pagination" shape #132
   asks every remaining spike to look for.
3. **But every page on `www.alisedainmobiliaria.com` — search and
   detail alike — is byte-identical to every other** (verified: MD5 of
   `/comprar-viviendas/andalucia` == MD5 of `/inmueble/ant00030657045` ==
   `3830b96daef4cb282d62a5d3736f0d6b`, both 29,747 bytes). It is a bare
   Angular app shell with **zero server-rendered content and no embedded
   JSON blob of any kind** — not even a `<title>`/meta description that
   varies per listing. A plain-HTTP connector (the only kind this project
   builds — issue #1 §15, no JS-executing headless browser at runtime) has
   nothing to parse on either page type.
4. Per the original #123 spike's own recommendation ("load the site in a
   real browser with DevTools open and find the XHR/fetch endpoint"), a
   one-time, two-page-load reconnaissance session (Playwright/Chromium,
   same honestly-identified UA, not part of any connector code) found the
   real data layer: `GET https://laravel.alisedainmobiliaria.com/api/v2/
   new-search?...` (search results) and `GET https://laravel.
   alisedainmobiliaria.com/api/get-property/<id>` (the exact fields the
   detail page renders — price, address, m², rooms, property sub-type,
   etc.). Both confirmed live: the search call for `andalucia/malaga`
   returned real filter/result data; the detail call for
   `ant00030657045` populated a real analytics beacon with
   `ciudad=POBLA DE SEGUR (LA)`, `provincia=Lérida`,
   `metros_cuadrados=463`, `habitaciones=5`, etc.
5. **`https://laravel.alisedainmobiliaria.com/robots.txt` is
   `User-agent: * / Disallow: /`** — an unqualified blanket disallow of
   the entire host, for every crawler, no exceptions. This is the one and
   only host that serves real listing data on this site. (For contrast,
   `apipro.alisedainmobiliaria.com` — the CMS/content backend behind menus,
   advisers, and promotional banners — has an ordinary Drupal robots.txt
   that does **not** block its own `/api/` paths; it was checked directly
   and confirmed to carry no property-catalog data, only CMS content.)

**Decision**: **Aliseda is not buildable as an automated connector, full
stop — not "inconclusive", not "needs more spiking".** The site's own
`User-agent: *` / `Disallow: /` on the one host that serves listing data
is the same category of signal this project has always treated as
binding (Servihabitat's narrower `User-agent: Scrapy / Disallow: /` was
enough to justify a more conservative rate limit even though it named a
different tool; an unqualified `*` disallow on the actual data API is
stronger, not weaker, evidence). No connector code was written against
`laravel.alisedainmobiliaria.com` — the two reconnaissance page loads
against the *allowed* `www` host were a one-time spike (mirroring how
every other connector's feasibility spike works), not a crawl of the
disallowed host itself.

This is functionally the same outcome as a WAF block (compliant automated
access to the data is impossible) reached by a different mechanism (an
explicit, readable, unambiguous policy statement instead of a technical
challenge) — **but it is not literally a "confirmed edge-WAF block"** in
the sense #132's standing rule names (no Incapsula/Akamai, no 403, no
CAPTCHA, robots.txt fully readable everywhere). Whether to route this to
the #75 browser-extension capture path (a human legitimately viewing
`/inmueble/<id>` in their own browser, which the extension then parses
client-side-rendered — the `www` host itself is not disallowed for that
URL) is therefore left as an explicit owner call, the same way #122
Altamira's close-vs-rescope question was surfaced rather than
auto-resolved.

**Consequence for #132's build order**: **#123 drops out of Tier 1.**
Rank moves to #126 Haya (previously Tier 1 #2) for the next Andalucía
build. #124 Anticipa's "check Aliseda overlap before spiking
independently" guidance is now moot in the other direction — there is no
Aliseda ingest to compare Anticipa against.

**Alternatives rejected**:
- Building a connector against `laravel.alisedainmobiliaria.com` anyway,
  on the theory that a `Disallow: /` on an API-only subdomain "probably
  just means keep Google from indexing JSON, not a real objection to a
  well-behaved bot": rejected outright — this project has never
  second-guessed a robots.txt disallow's intent, and won't start with the
  first unqualified `*`-scoped one it's hit in this batch (Sareb/Altamira
  were WAF technical blocks, not a policy statement to interpret).
- Scraping the app-shell HTML anyway and leaving every field `None`:
  rejected — a connector with literally nothing to extract on any page is
  not a thin/low-value connector, it is not a connector, and would just be
  dead code exercising an empty parse.
- Spoofing a search-engine-bot User-Agent to see if the site serves
  server-rendered content to `Googlebot` (dynamic rendering is common):
  rejected as a form of the same misrepresentation this project's spikes
  have always avoided ("honestly identified" is a standing constraint, not
  a suggestion) — not attempted.

**Rationale**: The site is genuinely sitemap-clean and permissively
robots-gated at the level the original correction checked, which is why
this took a real reconnaissance pass (not just a second robots.txt read)
to falsify. The lesson generalizes past this one issue: "sitemap-driven +
permissive robots.txt" is necessary but not sufficient evidence of
buildability for a client-rendered site — the page that a `discover()`/
`fetch_detail()` implementation will actually fetch over plain HTTP has to
be checked for real content, and if it's a JS shell, the API behind it
(found the same way this project already recommends — a real browser,
DevTools/network capture) needs its **own** robots.txt check before any
parsing code gets written.

**See**: [issue #123](https://github.com/alvarolobato/inmo-tool/issues/123), [issue #132](https://github.com/alvarolobato/inmo-tool/issues/132) (build order), [issue #75](https://github.com/alvarolobato/inmo-tool/issues/75) (browser-extension capture path), `docs/architecture/connectors.md` (Idealista capture-only precedent), the Servihabitat `User-agent: Scrapy` precedent in `etl/connectors/servihabitat.py`.
