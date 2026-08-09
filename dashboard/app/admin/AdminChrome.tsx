"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV, activeAdminHref } from "@/lib/admin-nav";

export default function AdminChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeHref = activeAdminHref(pathname);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Admin sub-nav strip — rendered from the single shared source in
          lib/admin-nav.ts so it can never drift from the /admin index. */}
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
          const isActive = item.href === activeHref;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
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
