import { permanentRedirect } from "next/navigation";

/**
 * Legacy route stub (#653/#636 Fase 0 borrado). "Uso LLM" merged into the
 * single consolidated `/admin/llm` page (usage content now leads that page).
 * Uses Next's `permanentRedirect()` (the semantic "this moved for good"
 * signal — `redirect()` is temporary) rather than a 404: unlike
 * `/admin/interactions` and `/admin/tool-calls` (deleted outright, 0 rows
 * ever), `llm_usage` is live (17,391 rows as of 2026-08-21).
 *
 * CAVEAT verified against a real build (review of #656): this does NOT put
 * a 308 + `Location` header on the wire for every client. Next's App Router
 * renders `permanentRedirect()` as a streamed RSC instruction
 * (`NEXT_REDIRECT;replace;/admin/llm;308`) inside a normal `200` HTML
 * document; the navigation happens client-side once React hydrates and
 * reads that instruction — this is root-layout/streaming behavior shared by
 * every redirecting page in this app (e.g. `/glossary`), not something
 * specific to this file. A browser bookmark or link still lands correctly.
 * A non-browser client (curl, a bot, a non-browser fetch) sees `200` with no
 * `Location` and must run JS to follow it — worth remembering before relying
 * on this pattern where a non-browser caller needs to follow the redirect
 * (see the #642 note about `/etl/salud`'s planned redirect, which the
 * installed browser extension's notification handler needs to actually
 * work — it will need a route-handler-level redirect, not a page-level one).
 */
export default function AdminUsageRedirect() {
  permanentRedirect("/admin/llm");
}
