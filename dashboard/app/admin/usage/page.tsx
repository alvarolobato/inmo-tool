import { permanentRedirect } from "next/navigation";

/**
 * Legacy route stub (#653/#636 Fase 0 borrado). "Uso LLM" merged into the
 * single consolidated `/admin/llm` page (usage content now leads that page) —
 * a PERMANENT redirect (308, Next's closest primitive to a 301 — unlike
 * `redirect()`, which is a 307/temporary) keeps old bookmarks and deep links
 * working. Unlike `/admin/interactions` and `/admin/tool-calls` (deleted
 * outright, 0 rows ever), `llm_usage` is live (17,391 rows as of 2026-08-21),
 * so this is a redirect, not a 404.
 */
export default function AdminUsageRedirect() {
  permanentRedirect("/admin/llm");
}
