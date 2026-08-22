"use client";

/**
 * The two Revisión queues, as a sub-nav (issue #642 P2).
 *
 * `/admin/dedup` (duplicate merges, #385) and `/admin/clasificacion` (redflag
 * vocabulary promotion, #399/D-087) had a strip tab each. They are one job —
 * "look at what the model proposed and decide" — done over two different
 * kinds of proposal, and #642's disposition table groups them under a single
 * "Revisión" section. Grouping them in the strip means one of the two loses
 * its tab, so this component is what keeps it one tap away.
 *
 * Deliberately NOT a new page. A "Revisión" index listing two links would be
 * a third route to reach two that already exist — the opposite of what this
 * phase is for. This is a switcher rendered on both pages, and the strip's
 * Revisión tab lands on whichever one you were last sent to by default
 * (`/admin/dedup`).
 *
 * Mobile-first (D-120): 44px minimum tap height, wraps rather than overflows.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const QUEUES = [
  { href: "/admin/dedup", label: "Duplicados" },
  { href: "/admin/clasificacion", label: "Clasificación" },
] as const;

export function RevisionTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Colas de revisión"
      data-testid="revision-tabs"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        marginBottom: 12,
      }}
    >
      {QUEUES.map((q) => {
        const isActive = pathname === q.href;
        return (
          <Link
            key={q.href}
            href={q.href}
            aria-current={isActive ? "page" : undefined}
            data-testid={`revision-tab-${q.href.split("/").pop()}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 44,
              padding: "0 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "var(--accent)" : "var(--fg-muted)",
              background: isActive ? "var(--accent-soft)" : "var(--bg-1)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {q.label}
          </Link>
        );
      })}
    </nav>
  );
}
