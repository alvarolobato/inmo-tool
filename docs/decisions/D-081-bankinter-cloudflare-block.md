---
id: D-081
title: Bankinter not buildable as a crawler — Cloudflare WAF on every path
date: 2026-08-06
group: Data / connectors
rule: 'Bankinter (`bankinter.com/…/cgi/ebk+inm+home`, #128) not buildable as a crawler: real ~500-listing REO portal, but Cloudflare "Just a moment" JS challenge 403s every path incl. robots.txt + the portal itself. No crawl connector; routes to browser-extension capture (#75) per the batch WAF rule (same as Sareb D-026 / Altamira D-027).'
order: 23
---

# D-081: Bankinter not buildable as a crawler — Cloudflare WAF on every path

*Decided: 2026-08-06*

**Context**: Issue #128 (part of the #132 bank/fund REO batch) asked whether Bankinter
runs a genuine standalone, crawlable property portal or only publishes via consumer-portal
pro pages. The feasibility spike (2026-08-06, honest descriptive User-Agent) found that a
real portal **does** exist — `bankinter.com/www/es-es/cgi/ebk+inm+home` (search) and
`…/cgi/ebk+inm+listado` (province results), ~500 REO listings by province — but the entire
`www.bankinter.com` domain is behind a **Cloudflare interstitial JS challenge**:

- `GET https://www.bankinter.com/robots.txt` → HTTP 403, body is the Cloudflare "Just a
  moment…" page (`cf_chl_opt`, `/cdn-cgi/challenge-platform/…`, `<noscript>` "Enable
  JavaScript and cookies to continue"). No real `robots.txt` is served.
- `GET …/cgi/ebk+inm+home` and `…/cgi/ebk+inm+listado` → HTTP 403, same "Just a moment…"
  challenge on both. The portal paths are not exempt from the challenge.

Passing this requires executing Cloudflare's JS challenge (a headless/JS-executing browser
or a CAPTCHA/turnstile solve), which is out of scope per issue #1 §15 and the batch's
standing WAF rule — the same stop condition as Sareb (Incapsula, D-026) and Altamira
(Akamai, D-027).

**Decision**: No live-crawling Bankinter connector is written — the site is not
respectfully crawlable over plain HTTP. Issue #128 is closed as not-feasible-as-a-crawler.
The portal renders fine for a human, so the correct route to this ~500-listing REO
inventory is the **browser-extension capture path (#75)** — a WAF 403 to a bot does not
predict human browsing (the Altamira D-027 lesson). A capture-only connector (scope_key →
None, born disabled, like Altamira/Aliseda) can be added later if the owner wants Bankinter
in the capture worklist; it is not built here because a Cloudflare-walled site yields no
real page to trim into a fixture, and no connector ships without a real fixture to test
`normalize()` against.

**Alternatives rejected**: (1) Bypassing the challenge with a headless browser / solver —
rejected per issue #1 §15, this is a personal tool, not a scraping operation. (2) Shipping
a crawl connector anyway on the assumption the challenge is intermittent — rejected: both
the portal home and results paths 403'd, and a connector that 403s every request is a
connector that trips its circuit breaker every run.

**Rationale**: Same batch rule as Sareb (D-026) and Altamira (D-027): a WAF 403 on every
path stops the crawler, and the browser-extension capture path is the documented fallback
for bot-protected sites that a human can still browse.

**See**: issue #128, tracking issue #132; D-026 (Sareb/Incapsula), D-027 (Altamira/Akamai,
capture-only precedent), #75 (browser-extension capture). Sibling verdicts this batch: D-080
(Lawbitat parked), D-082 (Deutsche Bank dead portal domain).
