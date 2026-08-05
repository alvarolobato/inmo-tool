---
id: D-071
title: Divarian (ex-Anida) not buildable — host unreachable, REO flows via Haya
date: 2026-08-06
---

# D-071: Divarian (ex-Anida) not buildable — host unreachable

*Decided: 2026-08-06*

**Context**: Issue #134 (part of the #132 bank/REO batch) asked for a
connector against Divarian (`divarian.com`, ex-Anida — BBVA's former real
estate arm, now Cerberus-majority). A prior spike run found the host
unreachable from that network; this is the **retry** the batch requested.

Live re-spike (2026-08-05, honest identifying User-Agent):

- `divarian.com` / `www.divarian.com` **resolve** (A record `212.80.175.92`)
  but every connection attempt **times out** on port 443 AND port 80 (curl
  `connect()` never completes, 20–40s).
- An **independent egress** (WebFetch, Anthropic's network) returns
  `connect ECONNREFUSED 212.80.175.92:443` — the host actively refuses / does
  not answer on 443 from a second, unrelated vantage point too.

So the domain resolves but the web server is effectively offline/unreachable
globally, not merely blocked from this environment — the retry **confirms**
the prior finding rather than overturning it.

**Decision**: **No connector written for Divarian.** There is no reachable
public portal to spike a `discover()`/`fetch_detail()` against. Per issue #134
itself and issue #126, part of the ex-Anida/Divarian book is serviced through
**Haya Real Estate**, which is already consolidated onto Solvia (D-021,
already ingested) — so the sellable inventory is not orphaned by not building
this connector. Close #134 with this finding; revisit only if `divarian.com`
comes back online with a crawlable public portal.

**Alternatives rejected**:
- *Retry from yet another network / assume transient downtime.* Rejected: two
  independent networks (this datacenter timing out, Anthropic egress actively
  refused) agree the host does not serve HTTP(S), and the good-neighbour
  discipline (issue #1 §15) says stop, not hammer. A future spike can re-check
  cheaply if there's reason to think it returned.

**See**: issue #134, issue #126 (Haya), D-021 (Haya→Solvia), D-018 (Solvia).
