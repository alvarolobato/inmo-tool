"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_NAV = [
  { href: "/etl", label: "Monitor ETL" },
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
