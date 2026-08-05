---
id: D-080
title: Lawbitat not buildable — parked domain, no standalone portal
date: 2026-08-06
---

# D-080: Lawbitat not buildable — parked domain, no standalone portal

*Decided: 2026-08-06*

**Context**: Issue #133 (part of the #132 bank/fund REO batch) asked for a Lawbitat
connector, but flagged the ownership and even the canonical domain as unverified — "it
may only exist as an idealista/yaencontre pro page, in which case there is no site to
crawl and this should be closed rather than built." The feasibility spike (2026-08-06,
honest descriptive User-Agent) confirmed exactly that:

- `www.lawbitat.com` is a CNAME to `parkingsrv0.dondominio.com` — a DonDominio
  domain-parking server. `https://` does not respond at all (connect fails, curl `000`);
  `http://` returns a DonDominio parking page: title "lawbitat.com | Registrado en
  DonDominio", body "Bienvenido a la página de parking de lawbitat.com … Este dominio ha
  sido registrado en DonDominio."
- The apex `lawbitat.com` resolves to a different IP but `https://` also fails to connect;
  `http://lawbitat.com/` 301s to the same parked `www` host.
- There is no `robots.txt`, no search page, no listing page, no HTML content of any kind —
  nothing to `discover()` or `fetch_detail()`.

Lawbitat's ~780–920 listings the issue cited exist only as a syndicated **pro-page
presence on idealista / yaencontre**, not on any Lawbitat-owned site. Those consumer
portals are separate connectors (idealista is capture-only #75; there is no yaencontre
connector), so nothing about this verdict blocks reaching that inventory by the normal
route.

**Decision**: No Lawbitat connector is written. `lawbitat.com` is a parked domain with no
standalone portal to crawl. Issue #133 is closed as not-feasible. If Lawbitat ever stands
up a real property portal on an owned domain, revisit then — the spike is cheap to repeat.

**Alternatives rejected**: Building a connector against the idealista/yaencontre pro pages
— rejected because that is not a Lawbitat portal, it is those consumer portals (idealista
is WAF-walled and handled capture-only per #75), and a "Lawbitat connector" pointed at
someone else's site would be mislabelled and duplicate inventory another connector's scope
already owns.

**Rationale**: Same standing rule as the rest of the batch — a portal that has no
crawlable owned site is not built (Ibercaja D-065, Haya D-021, Kutxabank D-074). A parked
domain is the strongest form of "no site": there is not even a shell to inspect.

**See**: issue #133, tracking issue #132; D-065 (Ibercaja, no DNS), D-021 (Haya→Solvia),
D-074 (Kutxabank→Servihabitat). Sibling verdicts this batch: D-081 (Bankinter WAF), D-082
(Deutsche Bank dead portal domain).
