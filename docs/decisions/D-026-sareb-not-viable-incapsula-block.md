---
id: D-026
title: Sareb not buildable — Incapsula WAF returns 403 on every path, including robots.txt itself
date: 2026-08-04
---

# D-026: Sareb not buildable — Incapsula WAF returns 403 on every path, including robots.txt itself

*Decided: 2026-08-04*

**2026-08-05 addendum** (issue #271): The owner ran a live human browsing test.
**Sareb stayed blocked even for a human, across two separate phones** — despite
its Incapsula **JS-challenge** signature, which this decision's Rationale read
as *positive* evidence a human would get through (a challenge "a real browser
resolves invisibly in the course of normal browsing"). That prediction was
**empirically wrong**. Altamira (D-027) went the other way: it renders normally
for a human despite a *static* Akamai deny that D-027 reasoned was a *weaker*
signal for human-browsing success. Net finding from this n=2 test: **the
WAF-response shape (JS challenge vs. static deny) does not reliably predict
whether a human browser gets content** — don't use it to prioritise capture
portals. The automated-connector verdict here is unchanged (still not buildable
as a crawler). **Sareb stays PARKED — no code work** (issue #271 explicitly
scopes Sareb out); reopen #121 only if a future capture attempt actually
renders. See D-027's matching addendum (Altamira, the "GO" portal this round).

**Context**: Issue #121, the largest single portfolio in #132's bank/fund
REO batch (Sareb, the Spanish state "bad bank"). An earlier same-day spike
(2026-08-02) found the site fully blocked by Incapsula and closed the
issue; #132's standing rule (owner decision, 2026-08-03 — "a confirmed
edge-WAF block routes to the browser-extension capture path (#75) rather
than being closed as not-viable") reopened it and rescoped it to capture,
without a per-decision record ever being written. This spike re-verifies
the block empirically rather than trusting that record as still current
— the same discipline that caught Haya's domain consolidation (D-021)
and BuildingCenter's real API (D-023) after their issues had been
provisionally triaged.

**Findings, live-verified 2026-08-04, honestly identified UA
(`inmo-tool/0.1 (personal real-estate research tool; contact via
github.com/alvarolobato/inmo-tool)`), 3 requests several seconds apart,
none retried**:

1. DNS: `www.sareb.es` resolves to `c59hy.x.incapdns.net` (CNAME) →
   `45.60.13.224`; the apex `sareb.es` resolves directly to
   `45.60.13.224`/`45.60.19.224`. `incapdns.net` is Imperva/Incapsula's
   own DNS delivery domain — the block is visible before a single HTTP
   request is made.
2. `GET https://www.sareb.es/robots.txt` → **HTTP 403**, `X-Iinfo` header
   and `visid_incap_96474` / `incap_ses_4559_96474` cookies (Incapsula's
   own instrumentation headers/cookies). There is no permissions signal
   to read or comply with — the file that would normally answer "what
   may a bot request" is itself refused.
3. `GET https://www.sareb.es/` → **HTTP 403**, same Incapsula signature.
4. `GET https://www.sareb.es/buscador-de-inmuebles` (a plausible listing
   search path) → **HTTP 403**, same signature.

Unchanged from the 2026-08-02 spike this re-verifies: that spike also
drove a real Chromium browser (Playwright 1.60, headed and headless,
default fingerprint, no stealth/spoofing, no proxy/IP rotation, no
CAPTCHA-solving) at `www.sareb.es` and got the same block — this session
did not repeat the browser pass since plain HTTP alone is sufficient to
confirm no regression happened, and re-running a headed browser session
against a WAF is not a cheaper way to ask the same question.

**Decision**: **Sareb is not buildable as an automated connector.** Every
request — including `robots.txt` itself — is rejected by an Incapsula
edge WAF with HTTP 403 before reaching any application logic. There is
no robots.txt to read, so there is nothing to comply with by construction
(issue #1 §15's stop condition); no connector code was written, no
evasion was attempted.

Per #132's standing rule (owner decision, 2026-08-03), this **routes to
the browser-extension capture path (#75)** rather than being closed —
see the #75 comment filed alongside this decision for what the extension
would need to grab. It is not auto-closed as not-viable.

**Consolidation context, unchanged from the earlier spike**: Sareb does
not sell directly — its ~€4.86bn portfolio is administered by servicers,
and per #132's tracking history that portfolio has consolidated onto
**Servihabitat** (#115, already shipped) and **Aliseda-Anticipa**
(#123/#124). Aliseda itself turned out not buildable for an unrelated
reason (D-019 — a client-rendered shell over a `Disallow: /` API host),
so **Servihabitat is currently the only automated path that reaches any
meaningful slice of ex-Sareb inventory**; the marginal loss from Sareb
being capture-only rather than crawlable is real but partially offset.

**Alternatives rejected**:
- Treating the earlier 2026-08-02 close as sufficient without a fresh
  request: rejected — the task explicitly calls for empirical
  re-verification, and WAF vendor configuration, IP allowlisting, and
  site infrastructure can all change over 2+ days. The DNS delegation to
  `incapdns.net` and the identical 403/cookie signature confirm nothing
  changed here, but that had to be checked, not assumed.
- CAPTCHA bypass, header spoofing, or fingerprint evasion to get past the
  WAF: out of scope per issue #1 §15, not attempted.
- Building a connector against a Googlebot-style spoofed User-Agent on
  the theory that Incapsula might dynamically render for search-engine
  crawlers: not attempted — this project's spikes have consistently
  avoided any form of misrepresenting the requesting client (see D-019's
  identical rejection for Aliseda).

**Rationale**: An edge WAF returning 403 on `robots.txt` itself is the
starkest form of "nothing to comply with" this project has hit — it is
categorically different from Aliseda's readable-everywhere-but-one-host
`Disallow: /` (D-019) or Haya's clean-but-redirected domain (D-021).
There is no plain-HTTP path here at all, headed-browser confirmation from
the prior spike rules out "just a User-Agent block," and the owner's
standing WAF→capture rule already resolves the close-vs-rescope question
for this exact shape — no further product judgment call is needed here.

One detail from the PR #224 review that is worth keeping, because it is the
part that decides whether capture will actually work: Sareb's 403 body is an
Incapsula **JS challenge** (a `<script src="/_Incapsula_Resource?SWJIYLWA=...">`
plus an iframe), not a static deny. A real browser resolves that invisibly
during ordinary browsing, so a human visiting the site would very likely see
content — positive evidence for the #75 extension path, and a genuinely
different prospect from Altamira (D-027), whose Akamai 403 carries no
challenge to satisfy at all. The challenge was not executed or solved and
nothing here proposes automating it; the point is that a person's own
browsing is a different signal from an automated fetch.

**See**: [issue #121](https://github.com/alvarolobato/inmo-tool/issues/121),
[issue #132](https://github.com/alvarolobato/inmo-tool/issues/132)
(tracking issue, standing WAF→capture rule recorded 2026-08-03),
[issue #75](https://github.com/alvarolobato/inmo-tool/issues/75)
(browser-extension capture path), [D-019](D-019-aliseda-not-viable-disallowed-api.md)
(Aliseda, the other current path to ex-Sareb inventory),
[D-021](D-021-haya-merged-into-solvia.md) (Haya, the batch's other
not-buildable precedent), `etl/connectors/servihabitat.py` (the connector
that currently carries the bulk of reachable ex-Sareb stock).
