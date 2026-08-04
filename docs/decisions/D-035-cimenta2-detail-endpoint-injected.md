---
id: D-035
title: Cimenta2 detail-fetch endpoint is injected via config; connector is discovery-only without it, and owner-contact fields are never stored
date: 2026-08-04
---

# D-035: Cimenta2 detail-fetch endpoint is injected via config; connector is discovery-only without it, and owner-contact fields are never stored

*Decided: 2026-08-04*

**Context**: Issue #136. The Cimenta2 connector shipped discovery-only under
[D-034](D-034-cimenta2-sitemap-index-only.md): it enumerated every Cajamar
asset from the public sitemap but fetched no per-property detail, so price,
size, coordinates and the rest stayed null. Property detail lives behind a
Salesforce Aura `getRecord` endpoint. The owner reviewed the data it returns —
the site's own listing fields (price, surface, address, coordinates, energy
rating, and so on; no owner PII in what was reviewed) — and decided it is fine
to fetch for their private tool.

Two constraints shape how that is done:

1. **This is a public repository.** The endpoint value is site-specific and
   must not be committed here. A clone without the secret must not be able to
   fetch detail.
2. **Owner-contact fields must never be read or stored.** The record shape
   includes fields for an owner's tax ID, telephone, IBAN and a named contact.
   The connector must be structurally incapable of surfacing them, whitelist or
   not.

**Decision**:

- The connector fetches detail **only when the endpoint is injected via
  configuration** (`CIMENTA2_DETAIL_ENDPOINT` env var / `cimenta2.detail_endpoint`
  config key, `sensitive`, default unset). With no endpoint configured
  `fetch_detail()` stays discovery-only and makes no request beyond
  `discover()`'s sitemap sweep — the public-safe default. The endpoint value is
  **never** written to any committed file (not code, `.env.example`, fixtures,
  tests, or decision records); it lives only in the owner's local config and a
  deployment secret.
- When configured, `fetch_detail()` performs one read-only GET of the public
  community shell to scrape the current Aura framework ids (so a stale build id
  is never carried) and one form-encoded POST of the **stock** Salesforce
  `getRecord` action per asset. The action descriptor is identical across every
  Experience Cloud community, so it is generic — not a site-specific access
  recipe — and lives in code. Honest User-Agent, framework-paced (~one request
  every 2–3s), read-only. A non-SUCCESS or still-expired response raises
  `ConnectorError`, which the circuit breaker counts and which stops a sweep
  cleanly rather than looping.
- `normalize()` reads an explicit **whitelist** of the site's public property
  fields and nothing else (`cimenta2_mapping.PUBLIC_FIELD_KEYS`). Owner-contact
  fields are absent from every field list the connector touches, so they can
  never enter a canonical row or `raw_extra`. Bank-internal commercial fields
  (acquisition cost, appraisal value) are stored in `listing.raw_extra` **only**
  when the operator opts in via `CIMENTA2_INCLUDE_INTERNAL` (bool, default
  false).
- `discovers_full_inventory` is unchanged (`True`); detail-fetch does not change
  discovery. With detail fetched, listings now carry non-null price and
  coordinates, so they surface in profile matching and dedup can corroborate
  beyond the bare reference-code tier.

**Supersedes**: [D-034](D-034-cimenta2-sitemap-index-only.md)'s "`fetch_detail()`
makes no request / never a detail path" stance, and
[D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md)'s "not buildable"
stance, on the single question of whether detail may be fetched at all. The rest
of both records stands (D-034's discovery mechanics; D-033's factual findings).

**Alternatives rejected**:

- *Hardcoding the endpoint in the connector.* Rejected: this is a public repo,
  and a committed endpoint is exactly what the config-injection requirement
  exists to avoid.
- *Reading owner-contact fields behind a second opt-in flag.* Rejected: they are
  never wanted for this tool, and the safest design is one where no code path
  references them at all — a flag would be a code path.
- *A local, uncommitted enrichment script instead of a connector method.*
  Rejected: the connector framework already gives rate limiting, circuit
  breaking, skip-if-seen and persistence; a side-channel script would duplicate
  all of it and bypass the observability the orchestrator provides.

**See**: [issue #136](https://github.com/alvarolobato/inmo-tool/issues/136),
[D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md),
[D-034](D-034-cimenta2-sitemap-index-only.md),
`etl/connectors/cimenta2.py`, `etl/connectors/cimenta2_mapping.py`,
`etl/config.py`, `config/schema.yaml`,
`etl/tests/test_connector_cimenta2.py`.
