/**
 * Single source of truth for the admin navigation (issue #508).
 *
 * Both consumers render from this one array so they can never drift again:
 *   - the admin strip (`app/admin/AdminChrome.tsx`), shown on every `/admin/*`
 *     and `/etl/*` page, and
 *   - the `/admin` index card grid (`app/admin/page.tsx`).
 *
 * Before this existed the two lists disagreed (the strip omitted Duplicados;
 * the index omitted every `/etl/*` surface) and names had drifted from where
 * the work actually happens. Add or reorder a tab HERE and both surfaces follow.
 *
 * Removal of the two extension-only surfaces (Extensión, Descubrimiento) is
 * deliberately NOT done here — it is owned by follow-up issues #509 and #511,
 * which reference this module. They stay listed (with `pendingRemoval`) so those
 * issues have a tab to remove and so the shipped extension/discovery features
 * remain reachable in the meantime. See #508 Scope OUT.
 */

export interface AdminNavItem {
  /** Canonical route this entry links to. */
  href: string;
  /** Short label for the strip tab. */
  label: string;
  /** Longer description for the `/admin` index card. */
  description: string;
  /**
   * Extra path prefixes (besides `href`) that should mark this entry active.
   * Used by the consolidated "LLM" landing, which groups four sub-routes.
   */
  matchPrefixes?: readonly string[];
  /**
   * Set when a follow-up issue owns removing this tab. Kept so the two
   * consumers stay in lock-step until that issue lands. Purely informational.
   */
  pendingRemoval?: string;
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    href: "/etl",
    label: "Monitor ETL",
    description:
      "Estado de sincronización, ejecuciones recientes y estadísticas del proceso ETL.",
  },
  // Connector management (#100) — an operator surface, gated via `/etl/:path*`.
  {
    href: "/etl/connectors",
    label: "Conectores",
    description: "Configuración de los conectores de los portales y su estado.",
  },
  // Guided-capture worklist (#237) — the ledger of "places to visit one by one"
  // for extension-only portals. Renamed from "Captura guiada": guided capture
  // itself now lives at `/captura`; this admin surface is the worklist ledger.
  {
    href: "/etl/captura",
    label: "Captura (admin)",
    description:
      "Registro de la captura asistida por extensión: qué portales visitar y el estado de cada tarea.",
  },
  // URL-building discovery (#336/#339). Pending removal — issue #511 folds the
  // aliseda drift check into Salud de datos and deletes this page.
  {
    href: "/etl/discovery",
    label: "Descubrimiento",
    description:
      "Comprobación de deriva en los filtros de los portales (extractor estático).",
    pendingRemoval: "#511",
  },
  // Data-health observability (#272) — read-only capture/ETL health.
  {
    href: "/etl/salud",
    label: "Salud de datos",
    description:
      "Salud de la captura y el ETL: capturas atascadas, fallos de conectores, calidad de extracción y perfiles obsoletos.",
  },
  // Extension setup (#256). Pending removal — issue #509 replaces the tab with
  // inline install/link CTAs where capture happens (keeps the route routable).
  {
    href: "/etl/extension",
    label: "Extensión",
    description: "Descarga la extensión del navegador y copia la URL/clave de la API.",
    pendingRemoval: "#509",
  },
  // Captured Idealista search URLs (#475, part of #471).
  {
    href: "/admin/captured-urls",
    label: "URLs capturadas",
    description:
      "URLs de búsqueda capturadas por la extensión (incluida la zona dibujada) para decodificar.",
  },
  // Redflag-vocabulary review (#399, Fase 8 of #385). Renamed from "Candidatos"
  // (which collided with property candidates) to "Clasificación"; old route
  // `/admin/candidatos` 301s here.
  {
    href: "/admin/clasificacion",
    label: "Clasificación",
    description:
      "Slugs candidate_type recurrentes que el modelo propuso en los redflags, para revisar y promover manualmente al vocabulario cerrado.",
  },
  // Duplicate-merge review (#385). Previously only on the `/admin` index; now on
  // the strip too so the two lists match.
  {
    href: "/admin/dedup",
    label: "Duplicados",
    description:
      "Cola de sugerencias de fusión de propiedades pendientes de confirmar o rechazar.",
  },
  // Consolidated LLM landing (#508): the four LLM diagnostics tabs (Consultas
  // lentas, Herramientas LLM, Uso LLM, Interacciones) collapse into one entry
  // whose landing links to each. The strip highlights it on any of them.
  {
    href: "/admin/llm",
    label: "LLM",
    description:
      "Diagnóstico del modelo de lenguaje: consultas lentas, uso de herramientas, tokens/coste e historial de interacciones.",
    matchPrefixes: [
      "/admin/slow-queries",
      "/admin/tool-calls",
      "/admin/usage",
      "/admin/interactions",
    ],
  },
  {
    href: "/admin/config",
    label: "Configuración",
    description:
      "Ver y editar la configuración del sistema (config.yaml) desde el navegador.",
  },
];

/**
 * The sub-pages grouped under the consolidated "LLM" landing, in display order.
 * Exported so the landing page and its tests share one list with the nav.
 */
export const ADMIN_LLM_SUBPAGES: readonly { href: string; label: string; description: string }[] = [
  {
    href: "/admin/slow-queries",
    label: "Consultas lentas",
    description: "Consultas SQL lentas registradas en los últimos días.",
  },
  {
    href: "/admin/tool-calls",
    label: "Herramientas LLM",
    description: "Uso de herramientas agénticas del modelo de lenguaje.",
  },
  {
    href: "/admin/usage",
    label: "Uso LLM",
    description: "Tokens consumidos y coste estimado por proveedor y función.",
  },
  {
    href: "/admin/interactions",
    label: "Interacciones LLM",
    description: "Historial de interacciones generate/modify/analyze con logs de herramientas.",
  },
];

/** All path prefixes that should mark a given nav item active. */
function matchPrefixesFor(item: AdminNavItem): readonly string[] {
  return item.matchPrefixes ? [item.href, ...item.matchPrefixes] : [item.href];
}

/**
 * Returns the `href` of the nav item that owns `pathname`, or `null` when none
 * do. Longest-prefix wins, so `/etl/connectors` highlights Conectores (not
 * Monitor ETL) and `/admin/usage` highlights the LLM tab (not itself).
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
