---
id: D-027
title: Altamira not buildable — Akamai edge WAF returns 403 on every path, including robots.txt itself
date: 2026-08-04
---

# D-027: Altamira not buildable — Akamai edge WAF returns 403 on every path, including robots.txt itself

*Decided: 2026-08-04*

**Context**: Issue #122, one of three Santander-family portals in #132's
bank/fund REO batch (alongside Aliseda #123 and Diglo #117). An earlier
same-day spike (2026-08-02) found the site blocked by Akamai and flagged
the close-vs-rescope call as an open owner decision; #132's standing rule
(owner decision, 2026-08-03 — "a confirmed edge-WAF block routes to the
browser-extension capture path (#75) rather than being closed as
not-viable") rescoped it to capture without closing it, but no
per-decision record was ever written and the block itself was never
re-verified after that rescoping. This spike does that: re-verifies the
block empirically rather than trusting the earlier finding as still
current, per the same discipline that caught Haya's domain consolidation
(D-021) and BuildingCenter's real API (D-023) turning out different from
what their issues originally assumed.

**Findings, live-verified 2026-08-04, honestly identified UA
(`inmo-tool/0.1 (personal real-estate research tool; contact via
github.com/alvarolobato/inmo-tool)`), 3 requests several seconds apart,
none retried**:

1. DNS: `www.altamirainmuebles.com` resolves via CNAME to
   `www.altamirainmuebles.com.edgekey.net` → `e68597.dscb.akamaiedge.net`
   → `95.101.38.164`/`95.101.38.169`. `akamaiedge.net` is Akamai's own
   edge-delivery domain — the block is visible before a single HTTP
   request completes, the same shape as Sareb's Incapsula delegation
   (D-026) but a different WAF vendor.
2. `GET https://www.altamirainmuebles.com/robots.txt` → **HTTP 403**,
   `server: AkamaiGHost`. As with Sareb, the one file that would normally
   declare what a bot may request is itself refused — there is no
   permissions signal to comply with.
3. `GET https://www.altamirainmuebles.com/` → **HTTP 403**, same
   `AkamaiGHost` signature.
4. `GET https://www.altamirainmuebles.com/venta/viviendas` (the listing
   search path named in the earlier spike) → **HTTP 403**, same
   signature.

Unchanged from the 2026-08-02 spike this re-verifies (`errors.edgesuite.net`
reference ID format, same `robots.txt`/homepage/search-page 403 pattern).
No browser-based re-check was run here (unlike Sareb's prior spike, the
earlier Altamira spike did not include a headed-Chromium pass); plain
HTTP alone is sufficient to confirm the WAF block is unchanged, and nothing
in this batch's findings so far suggests an edge-WAF 403 is ever a
User-Agent-only block rather than an infrastructure-level one.

**Decision**: **Altamira is not buildable as an automated connector.**
Every request — including `robots.txt` itself — is rejected by an Akamai
edge WAF with HTTP 403 before reaching any application logic. There is no
robots.txt to read, so there is nothing to comply with by construction
(issue #1 §15's stop condition); no connector code was written, no
evasion was attempted.

Per #132's standing rule (owner decision, 2026-08-03), this **routes to
the browser-extension capture path (#75)** rather than being closed —
see the #75 comment filed alongside this decision for what the extension
would need to grab. It is not auto-closed as not-viable.

**Consolidation context**: Altamira is one of three Santander-family
portals in this batch (with Aliseda #123 and Diglo #117) — the original
issue asked whether the three share a backend/markup that would make one
connector implementation adaptable to the others. That question is now
moot for Altamira specifically (there is no plain-HTTP path to adapt
anything onto), but is still open for Diglo, which has not yet been
re-spiked against its corrected domain (`digloservicer.com`) per #132's
tracking history.

**Alternatives rejected**:
- Treating the earlier 2026-08-02 close-vs-rescope open question, plus
  #132's standing-rule rescoping, as sufficient without a fresh request:
  rejected — the task explicitly calls for empirical re-verification of
  all three portals in this round, not just Sareb and Aliseda, and this
  portal's own block had never actually been re-checked after the
  standing rule was written, only referenced. The DNS delegation to
  `akamaiedge.net` and the identical 403/`AkamaiGHost` signature confirm
  nothing changed, but that had to be checked, not assumed from the
  2026-08-02 record.
- CAPTCHA bypass, header spoofing, or fingerprint evasion to get past the
  WAF: out of scope per issue #1 §15, not attempted.
- Independently spiking Diglo (`digloservicer.com`) as part of this same
  investigation, on the theory that a shared Santander backend might make
  the Altamira finding informative there too: out of scope for this
  issue — #132's tracking history already flags Diglo as needing its own
  fresh spike against the corrected domain, not an inference from a
  sibling brand's result (the same reasoning D-019/D-021/D-023 all used:
  every site in this batch gets checked independently, since shell shape
  and WAF vendor have not correlated cleanly with sibling ownership so
  far — CaixaBank's BuildingCenter and Solvia, both outside this WAF
  pattern, are the counter-examples).

**Rationale**: Same shape as Sareb (D-026) — an edge WAF returning 403 on
`robots.txt` itself, with the same "nothing to comply with" stop
condition, a different vendor (Akamai vs. Incapsula) but an identical
practical outcome. The owner's standing WAF→capture rule already resolves
the close-vs-rescope question this issue had left explicitly open on
2026-08-02; recording the decision file makes that resolution durable
instead of living only in a tracking-issue comment.

**See**: [issue #122](https://github.com/alvarolobato/inmo-tool/issues/122),
[issue #132](https://github.com/alvarolobato/inmo-tool/issues/132)
(tracking issue, standing WAF→capture rule recorded 2026-08-03),
[issue #75](https://github.com/alvarolobato/inmo-tool/issues/75)
(browser-extension capture path), [D-026](D-026-sareb-not-viable-incapsula-block.md)
(Sareb, the same failure shape with a different WAF vendor),
[D-019](D-019-aliseda-not-viable-disallowed-api.md) (Aliseda, the other
Santander-family portal in this batch, not buildable for a different
reason).
