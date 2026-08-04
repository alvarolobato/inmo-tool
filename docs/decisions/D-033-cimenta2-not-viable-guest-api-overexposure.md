---
id: D-033
title: Cimenta2 not buildable — no server-rendered content, and the only data path is an over-permissive guest API leaking confidential and personal fields
date: 2026-08-04
---

# D-033: Cimenta2 not buildable — no server-rendered content, and the only data path is an over-permissive guest API leaking confidential and personal fields

*Decided: 2026-08-04*

> **Superseded in part by [D-035](D-035-cimenta2-detail-endpoint-injected.md) (2026-08-04):** the owner reviewed the detail data (the site's own listing fields) and chose to have the connector fetch it in their private tool, with the endpoint injected via config and never committed to this public repo, and owner-contact fields never stored. D-035 governs detail-fetch; the rest of this record stands.

**Context**: Issue #136, Grupo Cooperativo Cajamar's REO portal
(`cimenta2.com`), part of #132's bank/fund batch. Unlike Sareb (D-026)
and Altamira (D-027), this site is **not** WAF-blocked — it responds
normally to honestly-identified plain-HTTP requests, and both hosts
involved publish permissive `robots.txt` files. It failed the spike for a
different and, as far as this batch goes, novel reason.

## Findings, live-verified 2026-08-04

Honest UA (`inmo-tool-research/0.1 (personal real-estate research tool;
contact: <owner email>)`), ~15 requests total, spaced out, none retried,
no evasion of any kind attempted. Nothing below required a spoofed
User-Agent, a solved challenge, or an authenticated session.

1. **`https://www.cimenta2.com/robots.txt` → HTTP 200**, and it is
   maximally permissive — the full body is three lines:
   `User-Agent: *`, `Disallow:` (empty — allow everything), and a
   `Sitemap:` pointer to `https://cimenta2.com/wp-sitemap.xml`. Nothing a
   `discover()`/`fetch_detail()` would need is disallowed. This is the
   opposite of the Fotocasa pagination problem (#65).

2. **The `cimenta2.com` WordPress sitemap contains no property
   inventory.** Its three child sitemaps cover pages, `destacado`
   (13 marketing campaign pages) and `promociones` (8 new-build
   development pages) — no individual assets.

3. **The real application is a separate host.** `/buscador-avanzado/`
   (the advanced search) is a WordPress page whose only meaningful
   content is `src="https://inmuebles.cimenta2.com/inmuebles/s/"` — a
   Salesforce Experience Cloud (Aura/Lightning) community. This is
   exactly the D-023 BuildingCenter shape at step 1, so per that lesson
   the backend host got its own check rather than concluding from the
   shell.

4. **The backend host's own `robots.txt` → HTTP 200 and also permissive**
   (Salesforce's stock communities file: `Allow: /`, one `Disallow:` for
   a password-reset JSP), declaring
   `https://inmuebles.cimenta2.com/inmuebles/s/sitemap.xml`.

5. **That sitemap is real, current, and substantial** (`lastmod`
   2026-08-04, i.e. same-day). It indexes per-object sitemaps, of which
   two matter:
   - `sitemap-ga_activo__c-1.xml` — **3,917 asset URLs**, shaped
     `/inmuebles/s/ga-activo/<18-char Salesforce id>/<numeric reference>`.
     The trailing slug is a per-property reference code (#72).
   - `sitemap-inv_expediente__c-1.xml` — **490 URLs**, shaped
     `/inmuebles/s/inv-expediente/<id>/<type>-<municipality>-<province>`,
     e.g. `chalet-antas-almeria`, `nave-fuente-alamo-murcia`. Heavy
     Almería/Murcia/Castellón weighting, as #136 predicted.

   So `discover()` would have been trivial and complete — this is the
   sitemap-driven shape that works flawlessly for Servihabitat and
   Vivantial. **The spike did not fail at discovery.**

6. **Every detail page is a contentless Lightning shell.** A real asset
   page returns 65 KB of HTML with `<title>Inmuebles</title>`, zero
   occurrences of the property's own type/municipality from its URL slug,
   no price, no JSON-LD, no embedded record JSON, and no component tree
   (components load at runtime). Fetching the same URL with the legacy
   `?_escaped_fragment_=` SEO-prerender parameter returned a
   **byte-identical** 65,098-byte response — there is no server-side
   rendering to opt into. The `cimenta2.com/buscador-avanzado/inv-expediente/<id>/`
   WordPress route is only an iframe wrapper around the same shell.

7. **The one path that does return data is an over-permissive guest
   API.** The shell names no separate REST backend (unlike
   BuildingCenter's `apifrontend` `<meta>` tag); the only data channel is
   Salesforce's own internal Aura RPC on the same host. A single
   read-only probe of the stock record-detail action, as an
   unauthenticated guest, returned **148 fields** for one asset.

   Alongside the ~15 fields the public site would legitimately display
   (price, surfaces, rooms, address, municipality, province, exact
   lat/long, cadastral reference, reference code) it returned the
   object's **entire internal field set**, including:

   - the bank's **acquisition cost** and **appraisal value** for the asset;
   - **offer-negotiation state** — minimum offer received, maximum offer
     approved, count of approved offers, pre-authorised price;
   - **owner-contact PII fields**, named in the schema for a presumed
     client's **tax ID, telephone and IBAN** (null on the sampled record,
     but present and readable on the guest-facing object);
   - a **named natural person** as the assigned manager, plus internal
     Salesforce user records on the audit fields.

   Deliberately **not recorded here**: the endpoint path, the framework
   tokens required, the action descriptor, the request recipe, the
   probe script, the captured response, and every real value observed.
   This is a public repository (AGENTS.md), and none of that is needed to
   justify the decision.

   No sweep was run. Exactly one record of each of the two object types
   was probed, purely to characterise feasibility, and probing stopped
   the moment the exposure was apparent.

**Decision**: **Cimenta2 is not buildable as an automated connector, and
the guest API must not be used.** No connector code was written.

The site publishes no server-rendered content and no documented or public
API, so there is no legitimate plain-HTTP surface to parse. The only
channel that yields data is an undocumented internal RPC whose guest
field-level security is misconfigured, and building on it would mean:

- **systematically harvesting data the site does not publish** —
  a lender's acquisition costs and live offer floors across ~3,900
  assets is confidential commercial information, not listing content;
- **ingesting exactly the personal data this project forbids** — owner
  tax ID / phone / IBAN fields and named individuals, against AGENTS.md's
  "no scraped personal data" rule and issue #1 §15's GDPR-minimisation
  stance;
- **depending on a security defect as production infrastructure** — the
  connector would break the day Cajamar corrects the permission, which
  they should.

**Scoping the request to only the ~15 publicly-displayed fields was
considered and rejected.** It would reduce the PII exposure but not the
core objection: the *reason* a guest can read the price field at all is
the same misconfiguration that exposes the IBAN field. Knowingly building
a data pipeline on a permission bug is not respectful crawling, whichever
subset of the leak we choose to consume, and it inherits the same
break-on-fix fragility.

**This routes to the browser-extension capture path (#75)**, and unusually
for this batch that is a genuinely *good* fit rather than a consolation
prize. The extension captures what the site actually **renders** to a
human — i.e. the public field subset Cajamar chose to display — which
sidesteps the over-exposure problem entirely instead of working around
it. A human browsing `cimenta2.com` normally sees a normal, working site.

**Responsible disclosure**: the owner should report the guest field-level
security misconfiguration to Cajamar. Details are being kept out of this
public repo on purpose; they can be reconstructed from this record's
description by anyone who needs to act on it, without publishing a
working recipe. Filed as a note on #136 rather than as a repo document.

**Alternatives rejected**:
- *Concluding "not buildable" from the contentless shell alone,
  without checking the backend host* — rejected, that is precisely the
  D-023 BuildingCenter error. The check was run, the backend host was
  permissive, and it answered. The verdict changed for a different
  reason than the one the shell suggested.
- *Spoofing a search-engine crawler User-Agent to obtain Salesforce's SEO
  pre-render* — out of scope per issue #1 §15, not attempted. The
  documented, non-spoofing `_escaped_fragment_` alternative was tested
  instead and returned the identical shell.
- *Reverse-engineering the site's bespoke Apex controllers out of the
  minified JS bundles to find a "more intended" data path* — rejected on
  the same grounds as the generic endpoint, plus it would be
  version-fragile (the framework UID and published-app version rotate on
  every Salesforce release and site publish).
- *Building the connector on the sitemap alone* — rejected as
  insufficient. 3,917 asset URLs plus a reference code and a
  type/municipality/province slug is real information, but with no price,
  surface or coordinates it cannot populate a `listing` row or feed #16's
  dedup signals.

  > **Revisited by [D-034](D-034-cimenta2-sitemap-index-only.md)
  > (2026-08-04), which supersedes this bullet only.** Two of its three
  > premises turned out to be false when checked against the code:
  > `listing.current_price` is nullable, so a row *can* be populated, and
  > the `reference_code` signal *is* reachable (capped at the
  > uncorroborated 0.500 suggest tier). The third premise was right and is
  > in fact understated — the geography slugs are worse than assumed. The
  > endpoint verdict below is untouched: the guest API must not be used,
  > for any field, under any scoping.

**Rationale**: This batch has now produced three distinct not-buildable
shapes, and the distinction is worth keeping: Sareb (D-026) and Altamira
(D-027) are **blocked** — the site refuses to talk to us; Aliseda (D-019)
is **forbidden** — the backend's own `robots.txt` says no; Cimenta2 is
neither. It invites us in, and the problem is that it hands over far more
than it means to.

That makes it the first site in this batch where the stop condition is
*our* restraint rather than *their* refusal — and the first where a
permissive `robots.txt` plus a clean sitemap plus a responsive backend
still adds up to "don't build it". A crawler-permissions file cannot
consent to disclosing a third party's bank account number; "not
disallowed" and "may be taken" are different questions, and this is the
case that separates them.

**See**: [issue #136](https://github.com/alvarolobato/inmo-tool/issues/136),
[issue #132](https://github.com/alvarolobato/inmo-tool/issues/132)
(bank/fund REO batch tracking issue),
[issue #75](https://github.com/alvarolobato/inmo-tool/issues/75)
(browser-extension capture path — the route this takes),
[issue #72](https://github.com/alvarolobato/inmo-tool/issues/72)
(reference code; Cimenta2 exposes one in its sitemap slugs),
[D-023](D-023-buildingcenter-national-sweep-connector.md) (the
check-the-backend-host lesson this spike applied),
[D-019](D-019-aliseda-not-viable-disallowed-api.md),
[D-026](D-026-sareb-not-viable-incapsula-block.md),
[D-027](D-027-altamira-not-viable-akamai-block.md) (the other
not-buildable portals in this batch, all for different reasons).
