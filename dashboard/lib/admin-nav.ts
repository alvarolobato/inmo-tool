/**
 * Single source of truth for the admin navigation (issue #508).
 *
 * ONE consumer today: the admin strip (`app/admin/AdminChrome.tsx`), rendered
 * on every `/admin/*` page. (The `/admin` index card grid it also fed was
 * replaced by the Estado board in #638; the array outlived it.)
 *
 * ── The six sections (#636 seq 5 / #642, end state) ─────────────────────
 *
 * Estado · Fuentes · Actividad · Revisión · LLM · Configuración
 *
 * #642 P2 is where the strip finally reaches that list, by REMOVING, never by
 * adding — the owner's standing complaint on the tracker is "solo has añadido,
 * no has eliminado nada… quiero que unifiques y elimines". What changed here:
 *
 *   - **Monitor ETL** (`/etl`) and **Salud de datos** (`/etl/salud`) are gone,
 *     with the routes themselves (P2 deleted the whole `/etl` tree; the paths
 *     keep wire-level 308s in `next.config.js`). Their content did not
 *     evaporate: run history → Actividad, per-source health → Fuentes/<name>,
 *     active blocks + zero-result regressions + the crawl rollups → Estado's
 *     Avisos/Rastreo bands.
 *   - **Estado** (`/admin`) gets a tab at last. It has been the landing since
 *     #638 and the strip never listed it, so the surface the owner is sent to
 *     on login was the one surface with no way back to it from the strip.
 *   - **Duplicados** + **Clasificación** become one **Revisión** tab. Both are
 *     manual review queues over model output; they are one job done in two
 *     places, and #642's disposition table groups them. The tab lands on
 *     `/admin/dedup` and both pages carry `<RevisionTabs/>` so the other queue
 *     is one tap away — a grouping, not a new page (this phase adds no route).
 *   - **Diagnósticos** (`/admin/diagnostics`, #671) and the extension setup
 *     page (`/admin/extension`, moved here by P2) are deliberately OFF the
 *     strip and owned by Fuentes via `matchPrefixes`: both are capture-source
 *     tooling reached from where capture is managed, and a seventh and eighth
 *     tab for two deep-link targets is exactly the sprawl this issue is
 *     undoing. Fuentes stays highlighted while you are on them.
 *
 *     `matchPrefixes` HIGHLIGHTS, it does not LINK. Each of the two therefore
 *     needs a real anchor somewhere, or dropping its tab deletes the page by
 *     omission — the one thing D-168 forbids. Both have one, on Fuentes:
 *     `/admin/extension` from `<ExtensionCta/>`'s "Abrir en página completa",
 *     `/admin/diagnostics` from the list header's "Diagnósticos →"
 *     (`fuentes-to-diagnostics`). `e2e/admin-nav.spec.ts` reaches both by
 *     CLICKING, not by `goto` — a highlight test cannot catch an orphan.
 *
 * Add or reorder a tab HERE. `e2e/admin-nav.spec.ts` asserts the rendered
 * label list EXHAUSTIVELY, so a new tab cannot appear without a deliberate
 * edit in both places.
 */

export interface AdminNavItem {
  /** Canonical route this entry links to. */
  href: string;
  /** Short label for the strip tab. */
  label: string;
  /** Longer description — kept as the entry's own documentation. */
  description: string;
  /**
   * Extra path prefixes (besides `href`) that should mark this entry active:
   * routes with no tab of their own that nonetheless belong to this section.
   */
  matchPrefixes?: readonly string[];
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  // Estado (#638 + #640 + #642 P2) — the landing, and now a tab. Per-source
  // health derived from the `listing` table, the Avisos band (active capture
  // blocks, zero-result regressions), the Colas band and the Rastreo rollups.
  {
    href: "/admin",
    label: "Estado",
    description:
      "Qué está funcionando ahora mismo: una fila por fuente, avisos activos, colas y el resumen de rastreo.",
  },
  // Fuentes (#642 P1) — merged the old "Conectores" (`/etl/connectors`) and
  // "Captura (admin)" (`/etl/captura`) tabs into one per-source surface: a
  // lean list (`/admin/fuentes`) linking to a detail page
  // (`/admin/fuentes/[name]`) that carries connector config, the capture
  // worklist ledger, and per-source quality/zero-result/drift sections.
  {
    href: "/admin/fuentes",
    label: "Fuentes",
    description:
      "Cada fuente (conector o portal de captura): configuración, ejecución, captura y calidad.",
    matchPrefixes: ["/admin/diagnostics", "/admin/extension"],
  },
  // Actividad (#644) — the unified ingest chronology: crawl sweeps,
  // browser-capture sessions, re-capture batches, dedup passes, manual
  // triggers, listing status changes and capture block episodes, merged into
  // one time-ordered feed. Owns the run drill-down (`/admin/actividad/run/
  // [id]`, moved from `/etl/[id]` by P2) as a child route, so no extra
  // prefix is needed for it.
  {
    href: "/admin/actividad",
    label: "Actividad",
    description:
      "Cronología de la ingesta: rastreos, sesiones de captura, recolas, pasadas de dedup, retiradas y bloqueos, en un solo hilo.",
  },
  // Revisión (#642 P2) — the two manual review queues under one tab:
  // duplicate merges (#385) and redflag-vocabulary promotion (#399, D-087).
  // The tab lands on Duplicados; `<RevisionTabs/>` on both pages switches
  // between them.
  {
    href: "/admin/dedup",
    label: "Revisión",
    description:
      "Las dos colas de revisión manual: fusiones de propiedades duplicadas y slugs candidate_type propuestos por el modelo.",
    matchPrefixes: ["/admin/clasificacion"],
  },
  // Consolidated LLM page (#508, further unified in #653/#636 Fase 0 borrado):
  // usage, cost/coverage and slow-queries all live on this one page now.
  // "Herramientas LLM" (`llm_tool_calls`) and "Interacciones" (`llm_interactions`)
  // were deleted outright — both tables have 0 rows ever in production. Only
  // `/admin/usage` survives as a redirect (its data, `llm_usage`, is live);
  // `/admin/slow-queries` is gone (its content is a collapsed disclosure here).
  //
  // No `matchPrefixes: ["/admin/usage"]` any more (#642 P2, PR #710 review):
  // that entry existed because `/admin/usage` was a page-level
  // `permanentRedirect()` stub, so the browser sat on `/admin/usage` while
  // `/admin/llm` rendered and the tab needed the prefix to stay lit. P2 made
  // it a wire-level 308 in `next.config.js` like every other retired path, so
  // the URL is `/admin/llm` before anything renders and `href` alone matches.
  // A prefix for a path no browser can be on is dead code that reads as a
  // surviving route.
  {
    href: "/admin/llm",
    label: "LLM",
    description:
      "Uso del modelo (tokens/coste), coste y cobertura de evaluación IA, y consultas SQL lentas.",
  },
  {
    href: "/admin/config",
    label: "Configuración",
    description:
      "Ver y editar la configuración del sistema (config.yaml) desde el navegador.",
  },
];

/** All path prefixes that should mark a given nav item active. */
function matchPrefixesFor(item: AdminNavItem): readonly string[] {
  return item.matchPrefixes ? [item.href, ...item.matchPrefixes] : [item.href];
}

/**
 * Returns the `href` of the nav item that owns `pathname`, or `null` when none
 * do. Longest-prefix wins, which is what makes the Estado entry safe: `/admin`
 * is a prefix of every other admin route, and without longest-prefix it would
 * swallow all of them. So `/admin/fuentes/<name>` highlights Fuentes,
 * `/admin/clasificacion` highlights Revisión, `/admin/actividad/run/7`
 * highlights Actividad, and only a bare `/admin` highlights Estado.
 *
 * The `/etl/*` tree no longer reaches this function at all — #642 P2 deleted
 * every page under it, so those paths 308 to their new home before a layout
 * ever renders (pinned in `lib/__tests__/admin-nav.test.ts`).
 */
export function activeAdminHref(pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  for (const item of ADMIN_NAV) {
    for (const prefix of matchPrefixesFor(item)) {
      if (pathname === prefix || pathname.startsWith(prefix + "/")) {
        if (!best || prefix.length > best.len) {
          best = { href: item.href, len: prefix.length };
        }
      }
    }
  }
  return best?.href ?? null;
}
