"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFreshness } from "@/components/FreshnessContext";

interface TopBarProps {
  onCogClick?: () => void;
  /** Override freshness text — falls back to context value */
  freshnessText?: string;
  /** Override freshness stale flag — falls back to context value */
  freshnessStale?: boolean;
  /** Override freshness tooltip (last-sync timestamp) — falls back to context value */
  freshnessTooltip?: string | null;
  /** Public URL of this dashboard app (for self-referencing links). */
  appPublicUrl?: string;
  /** Public URL of WrenAI — used for the "Wren" nav link. */
  wrenPublicUrl?: string;
}

export function TopBar({
  onCogClick,
  freshnessText: propFreshnessText,
  freshnessStale: propFreshnessStale,
  freshnessTooltip: propFreshnessTooltip,
  wrenPublicUrl = "http://localhost:3000",
}: TopBarProps) {
  const pathname = usePathname();
  const ctx = useFreshness();
  const freshnessText = propFreshnessText ?? ctx.freshnessText;
  const freshnessStale = propFreshnessStale ?? ctx.freshnessStale;
  const freshnessTooltip = propFreshnessTooltip ?? ctx.freshnessTooltip;

  const navLinks = [
    { href: "/inicio", label: "Inicio" },
    { href: "/paneles", label: "Paneles" },
    { href: "/conversations", label: "Conversaciones" },
    { href: "/review", label: "Revisión" },
    { href: wrenPublicUrl, label: "Wren", external: true },
  ] as const;

  return (
    <header
      style={{ height: 56, borderBottom: "1px solid var(--border)", background: "var(--bg-1)" }}
      className="sticky top-0 z-20 flex items-center justify-between shrink-0"
    >
      {/* Left: logo + nav */}
      <div className="flex items-center gap-6 px-5">
        {/* Powershop bolt logo */}
        <div className="flex items-center gap-1.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 2 L14 2 L20 11 L10 22 L4 22 L4 13 L11 13 L8 9 L4 9 Z" fill="var(--accent)" />
          </svg>
          <span
            style={{
              fontFamily: "var(--font-inter), sans-serif",
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: "var(--fg)",
            }}
          >
            Powershop
          </span>
          <span
            style={{
              fontFamily: "var(--font-jetbrains), monospace",
              fontSize: 11,
              color: "var(--fg-subtle)",
              marginLeft: 2,
            }}
          >
            ANALYTICS
          </span>
        </div>

        {/* Primary nav */}
        <nav className="flex items-center gap-1">
          {navLinks.map((link) => {
            const isExternal = "external" in link && link.external;
            const isActive =
              !isExternal &&
              (link.href === "/inicio"
                ? pathname === "/" || pathname.startsWith("/inicio")
                : pathname.startsWith(link.href));
            const style = {
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              color: isActive ? "var(--fg)" : "var(--fg-muted)",
              background: isActive ? "var(--bg-2)" : "transparent",
              textDecoration: "none",
            } as const;
            if (isExternal) {
              return (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={style}
                >
                  {link.label}
                </a>
              );
            }
            return (
              <Link key={link.href} href={link.href} style={style}>
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Right: status + cog + admin + avatar */}
      <div className="flex items-center gap-3 px-5">
        {/* Live status */}
        <div
          className="flex items-center gap-1.5"
          title={freshnessTooltip ?? undefined}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: freshnessStale ? "var(--warn)" : "var(--up)",
              animation: "pulse-dot 2s ease-in-out infinite",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              fontFamily: "var(--font-jetbrains), monospace",
              cursor: freshnessTooltip ? "help" : "default",
            }}
          >
            {freshnessText || "Datos al día"}
          </span>
        </div>

        {/* Cog */}
        <button
          type="button"
          onClick={onCogClick}
          aria-label="Ajustes de visualización"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-muted)",
            padding: "4px 8px",
            borderRadius: 6,
            height: 32,
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg-muted)")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* Admin link */}
        <Link
          href="/admin"
          style={{
            fontSize: 13,
            fontWeight: 400,
            color: "var(--fg-muted)",
            textDecoration: "none",
            padding: "6px 12px",
            borderRadius: 6,
          }}
        >
          Admin
        </Link>

        {/* Avatar */}
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            fontSize: 11,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
          aria-label="Avatar de usuario"
        >
          AL
        </div>
      </div>
    </header>
  );
}
