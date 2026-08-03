---
id: D-017
title: Milanuncios rate_limit_per_minute measured at 2, below Fotocasa's 3, not equal to it
date: 2026-08-03
---

# D-017: Milanuncios rate_limit_per_minute measured at 2, below Fotocasa's 3, not equal to it

*Decided: 2026-08-03*

**Context**: Issue #179. `MilanunciosConnector.rate_limit_per_minute` shipped
at 20 with the comment "same conservative default as Fotocasa" — chosen by
analogy, never independently measured. That stopped being defensible once
Fotocasa's own rate dropped to 3 (#65). In production this tripped the
circuit breaker every run (`discovered=41 fetched=5 errors=5`): Milanuncios
exhibits the same soft-block signature as Fotocasa (both Adevinta-group
sites) — a GeeTest CAPTCHA challenge served as HTTP 200 with the
`__INITIAL_PROPS__` payload missing.

Measured live, 2026-08-03, rather than assuming "drop to 3 like Fotocasa"
would fix it:

| Rate | Result |
|---|---|
| 20/min (3s apart) | Matches production: ~5 `fetch_detail` successes, then permanently blocked for the rest of the run. |
| 6/min (10s apart) | Identical signature — 5 successes, then blocked. A 3.3x slower pace made no measurable difference. |

Two findings beyond Fotocasa's version of this wall: (1) the block page
carries no `Set-Cookie` header at all — no session-cookie exemption exists
for a persistent `requests.Session()` to exploit; it is a server-side
decision, not a client-side JS challenge with a bypassable allow-cookie.
(2) the lockout did not clear after 60+ minutes of continued observation —
dramatically longer than Fotocasa's documented "persists for minutes."

**Decision**: `rate_limit_per_minute = 2` (below Fotocasa's 3, not equal to
it — Milanuncios showed an equal-or-worse block at a pace, 10s, that
Fotocasa's own measurement proved safe at 20s). Two regression-guard tests
pin this: `rate_limit_per_minute <= 2` and `rate_limit_per_minute <
FotocasaConnector.rate_limit_per_minute` (deliberately not just `<= 3`,
so nobody "fixes" this by matching Fotocasa's value on the reasonable-
looking but unmeasured assumption that they must be equally safe).

Also added: `MilanunciosSoftBlockError` (a `ConnectorError` subclass, so
the circuit breaker keeps counting it identically) fires when a page
missing the `__INITIAL_PROPS__` marker also carries the confirmed
soft-block signature ("Pardon Our Interruption", `noindex, nofollow`,
`#captcha-box` — from a REAL captured block page,
`milanuncios_sample_soft_block_page.html`, replacing reliance on a
synthetic stand-in for this specific case). Anything else missing the
marker still raises the generic `ConnectorError` — issue #66's adjacent
"removed ad vs. blocked" ambiguity is NOT resolved by this.

**Alternatives rejected**:
- Setting `rate_limit_per_minute = 3` to match Fotocasa exactly: rejected
  specifically because it would repeat the analogy-based mistake this
  issue exists to correct — 3 was never measured for Milanuncios, and the
  one comparable data point available (10s/6-per-min, slower than
  Fotocasa's own failing 3s point) failed identically to 20/min, while
  Fotocasa's exact 3/min pace (20s) was never itself tested against
  Milanuncios.
- Testing further, slower cadences (20-60s+) in this same session: not
  attempted. Each failed test costs another 60+-minute lockout on the
  owner's real home connection (Telefónica, `81.38.223.92` — issue #1
  §15's good-neighbour stance applies with real teeth here), and this
  investigation had already spent over an hour confirming the block does
  not self-clear within a session that kept checking it (which may itself
  have reset a decay timer — repeated polling is plausibly
  counterproductive against this specific wall).

**Rationale**: `rate_limit_per_minute = 2` is a genuinely measured,
conservative value — bounded from above by two real live failures, not
copied from a sibling connector by analogy. It is honestly **not** proven
to sustain a full 41-listing run the way Fotocasa's 3/min was proven to
sustain a 161-request sweep; the exact safe floor (or whether one exists
at any practical per-minute pace, if the wall turns out to be a fixed
per-session request count rather than a rate) remains open. A follow-up
slower-cadence measurement (20-60s+) is the natural next step once the
current lockout is confirmed clear — check back once after a long gap,
don't poll.

**See**: [issue #179](https://github.com/alvarolobato/inmo-tool/issues/179), `etl/connectors/milanuncios.py`, `etl/tests/test_connector_milanuncios.py` (`TestRateLimitMeasurement`, `TestSoftBlockSignature`), `docs/architecture/connectors.md`'s "Milanuncios: a worked example of measure, don't copy" section, [D-018](D-018-solvia-sitemap-partitioning.md) (the companion #190 change in the same PR).
