"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_NAV = [
  { href: "/etl", label: "Monitor ETL" },
  // Connector management (#100). An operator surface, so it lives in this
  // admin strip rather than the main TopBar — same reasoning (and the same
  // middleware gating, via the `/etl/:path*` matcher) as Monitor ETL above.
  { href: "/etl/connectors", label: "Conectores" },
  // Guided capture worklist (#237) — the "places to visit one by one" surface
  // for extension-only portals (Aliseda). Same /etl admin gating.
  { href: "/etl/captura", label: "Captura guiada" },
  // URL-building discovery (#336/#339) — sits next to Captura guiada because it
  // is the other extension-driven surface: enumerate a portal's filter options
  // + the URL each produces to teach the connector's URL builder. Same gating.
  { href: "/etl/discovery", label: "Descubrimiento" },
  // Data-health observability (#272) — read-only capture/ETL health: stuck
  // captures, connector failures, extraction quality, stale profiles. Same
  // /etl admin gating. Health, not config (config lives on Conectores).
  { href: "/etl/salud", label: "Salud de datos" },
  // Extension setup (#256) — download the extension + copy the API URL/key.
  { href: "/etl/extension", label: "Extensión" },
  // Promotion review (#399, Fase 8 of #385) — recurring `candidate_type` slugs
  // the model coined in redflags `other` flags, for the owner to review and
  // (manually) promote to the closed vocabulary. Sits after the extension
  // capture surfaces; same /admin gating.
  { href: "/admin/candidatos", label: "Candidatos" },
  { href: "/admin/slow-queries", label: "Consultas lentas" },
  { href: "/admin/tool-calls", label: "Herramientas LLM" },
  { href: "/admin/usage", label: "Uso LLM" },
  { href: "/admin/interactions", label: "Interacciones" },
  { href: "/admin/config", label: "Configuración" },
];

export default function AdminChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Admin sub-nav strip */}
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
        aria-label="Administración"
      >
        {ADMIN_NAV.map((item) => {
          const isActive = item.href === "/etl"
            ? pathname === "/etl" || pathname.startsWith("/etl/")
            : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--accent)" : "var(--fg-muted)",
                background: isActive ? "var(--accent-soft)" : "transparent",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {/* Page content */}
      <div style={{ flex: 1, overflow: "auto", padding: "var(--pad, 20px)" }}>
        {children}
      </div>
    </div>
  );
}
