# Attribution

This browser extension is forked from [`RealEstateWebTools/property_web_scraper`](https://github.com/etewiah/property_web_scraper)'s `chrome-extensions/property-scraper/` directory (MIT License, Copyright (c) 2017 Real Estate Web Tools / Ed Tee), per issue #75's decision to reuse their working extension as-is rather than rebuild one from scratch.

`content-script.js` is unchanged from the original — it was already exactly the "capture rendered HTML + URL on message" shape this project needs.

Everything else was adapted for a single-deployment personal tool rather than their multi-tenant SaaS:

- **Removed entirely**: the "haul" concept (anonymous multi-tenant scrape collections), their per-account API-key/signup model, `haul-history.js` and its local-storage scrape history UI, the signup/limit-reached/no-key/haul-expired popup states. None of this applies to a tool with exactly one owner and one backend. A much simpler admin-key field remains (options page → "Clave de administrador") — the capture endpoint is a network-facing write path into the ingestion pipeline, so it's gated by the same `ADMIN_API_KEY` every other admin surface on the dashboard already requires (Opus review, PR #87 — the endpoint was unauthenticated for a time during development).
- **Trimmed**: `manifest.json`'s host permissions and content-script matches, from ~18 international portals down to Idealista only (this project's actual target — see issue #75). Extend this list if the capture pattern proves useful for other bot-protected sites later.
- **Repointed**: the default API URL, from `https://property-web-scraper.pages.dev` to inmo-tool's own capture endpoint (`/api/extension/capture`), configurable via the options page for whatever host the dashboard runs on.
- **Simplified**: the popup's result view — no grade badge (that concept belongs to their server's own scoring; inmo-tool's response shape is `{success, property_id, fields_extracted, fields_available}`), no "View Haul" link (replaced with a direct link to inmo-tool's own property detail page once one exists — see issue #44).

See `LICENSE-MIT-property_web_scraper.txt` for the original license text, reproduced per its terms.
