---
id: D-021
title: Haya not buildable — the domain now redirects entirely to Solvia (already ingested)
date: 2026-08-04
group: Data / connectors
rule: 'Haya (`haya.es`) not buildable: the whole domain 301-redirects to `solvia.es` (already ingested, D-018) — Intrum merged Haya into the Solvia servicer brand. No connector written.'
order: 31
---

# D-021: Haya not buildable — the domain now redirects entirely to Solvia (already ingested)

*Decided: 2026-08-04*

**Context**: Issue #126, ranked #2 in #132's Andalucía-first build order
(and the top candidate after #123 Aliseda was found not buildable — see
[D-019](D-019-aliseda-not-viable-disallowed-api.md)). The #126 light spike
had found `https://www.haya.es/robots.txt` returns only the Cloudflare
"Content Signals Policy" stub (no classic `Disallow:`, no `Sitemap:` line)
and flagged a real, dated (2020) Andalucía figure (1,210 total, Málaga
280) plus a "may subsume #134 Divarian's BBVA book" angle to check during
the real spike.

**Findings, live-verified 2026-08-04, honestly identified UA
(`inmo-tool/0.1 (personal real-estate research tool; contact via
github.com/alvarolobato/inmo-tool)`), a handful of requests seconds to
minutes apart, none retried**:

1. `https://www.haya.es/robots.txt` — confirmed exactly as the light spike
   described: HTTP 200, Cloudflare content-signals stub only, no
   `Disallow:`/`Sitemap:` lines. Nothing blocked, but nothing to anchor
   discovery on either.
2. **`https://www.haya.es/` returns `HTTP/2 301` to
   `https://www.solvia.es`** — a different second-level domain entirely,
   not a same-site path change. Confirmed via response headers (Cloudflare
   `cf-ray`, `strict-transport-security`, a literal `location:
   https://www.solvia.es` header), not inferred from a client-side
   redirect or meta-refresh.
3. `https://www.haya.es/en/` — same 301 to `https://www.solvia.es/`. Not a
   one-off on the bare root.
4. `https://www.haya.es/inmuebles/` and `https://www.haya.es/venta/` —
   plausible former listing-index paths — both return `404`, not a
   redirect. There is no surviving in-domain content to enumerate; the
   only thing the domain still does is bounce every request to Solvia.
5. `https://haya.es/` (no `www`) — `Could not resolve host`, doesn't
   exist in DNS at all.
6. `https://compras.haya.es/...` (a vendor-portal subdomain surfaced by a
   web search, `.../custom/HRE/public/quienes-somos.html`) — `Could not
   resolve host`. Search-engine-indexed but dead; the search results for
   this domain generally are stale, e.g. a listed `haya.es/en/` result and
   several third-party portal reposts.
7. No CAPTCHA, no WAF challenge, no rate-limit response of any kind was
   observed on any request — the domain answers cleanly and immediately,
   it just has nothing of its own left to answer with.
8. **Independent confirmation this is a real, structural merger, not a
   marketing microsite move**: press coverage (El Economista, EjePrime,
   Casacochecurro, Brains Real Estate News, mid-2020s) reports Intrum
   merged its four Spanish servicer brands — **Haya, Solvia, Aktua, and
   HRE** — into a single entity ("Solvia Servicios Inmobiliarios"),
   consolidating roughly 170,000 assets. Intrum bought Haya from Cerberus
   in September 2023 and folded it into the group already built around
   Solvia (acquired from Sabadell in 2019). This is the batch's own
   "sibling of Solvia and Casaktua under Intrum" note (#126's issue body)
   playing out as a full brand consolidation, not just a shared backend.

**Decision**: **Haya is not buildable as an independent connector, full
stop — there is no separate site left to build one against.**
`www.haya.es` is not a distinct property portal with its own listings; it
is a domain-level 301 to `https://www.solvia.es`, which this project
**already ingests** ([D-018](D-018-solvia-sitemap-partitioning.md),
issue #116/#138). Any inventory that used to be Haya's own is, per the
press coverage, now inside the same consolidated servicer group Solvia's
connector already sweeps — not a separate pool to compare against or
partially overlap with. No connector/mapping/test code was written.

This is a different failure shape from both prior spikes in this batch:
not a WAF/CAPTCHA block (#121 Sareb, #122 Altamira — no #132 standing-rule
routing applies) and not a client-rendered shell with a disallowed API
host (#123 Aliseda, D-019) — it is the simplest possible answer: **the
site the issue asks about no longer independently exists.**

**Alternatives rejected**:
- Building against `solvia.es` a second time under the `haya` connector
  name, on the theory that a "Haya connector" could just be a relabeled
  Solvia sweep: rejected — that would be the existing `SolviaConnector`
  under a second name, hitting the exact same URLs, doubling rate-limit
  budget and fetch load against one site for zero incremental data. If
  Solvia's own coverage of ex-Haya stock ever needs a distinct label
  (e.g. to preserve a `source` value for provenance), that is a Solvia
  connector enhancement, not a new connector.
- Treating the light spike's dated 2020 press figures (Andalucía 1,210,
  Málaga 280) as still-relevant sizing for a build decision: moot — those
  figures described Haya's book at a point when it was a live, separate
  business; the business itself no longer operates a separate storefront
  to measure today.
- Chasing the `#134 Divarian` angle (the #126 light spike's "may subsume
  Divarian's BBVA book" note) further from here: out of scope for this
  issue — whatever relationship Haya (now Solvia-group) has with Divarian
  is #134's own spike to make, not something this investigation needed to
  resolve to answer #126.

**Rationale**: The spike-first discipline this batch has followed twice
already (D-019's "sitemap-driven + permissive robots.txt is necessary but
not sufficient" lesson) generalizes one step further here: a permissive,
sitemap-less robots.txt on a domain that has been fully absorbed by a
sibling brand is *also* not sufficient evidence of buildability — the
"fetch a real detail page" step of the spike checklist catches this
immediately, before any parsing code gets written, the same way it was
designed to. Overlap sampling (#132's Casaktua→Solvia,
Kutxabank→Servihabitat concern) doesn't apply in its usual "fetch a dozen
listings and compare" form here, because there is no separate Haya
inventory left to sample — the redirect itself **is** the overlap
finding, at 100%, by construction.

**Consequence for #132's build order**: **#126 drops out of the ranking
entirely** (not just out of Tier 1) — there is no site to rank. The next
Andalucía build candidate per the existing Tier 1/2 list is **#118
BuildingCenter** (Sevilla 57 confirmed live, flagged for its own
client-side-rendering risk to verify the same way this issue and #123
were) or, if that risk materializes, **#136 Cimenta2** (Tier 2, clean
sitemap-driven signal, lower Málaga/Sevilla volume). Also worth flagging
for whoever picks up #134 Divarian: the "Haya may subsume Divarian's BBVA
book" question from #126's light spike should now be asked about
Solvia-group generally, since Haya no longer exists as the entity that
question was originally about.

**See**: [issue #126](https://github.com/alvarolobato/inmo-tool/issues/126),
[issue #132](https://github.com/alvarolobato/inmo-tool/issues/132) (build
order), [D-018](D-018-solvia-sitemap-partitioning.md) (the Solvia
connector this domain now redirects into), [D-019](D-019-aliseda-not-viable-disallowed-api.md)
(the prior "spike first" save in this same batch), `etl/connectors/solvia.py`.
