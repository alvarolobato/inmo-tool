"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFreshness } from "@/components/FreshnessContext";

interface TopBarProps {
  onCogClick?: () => void;
  /** Override freshness text — falls back to context value */
  freshnessText?: string;
  /** Override freshness stale flag — falls back to context value */
  freshnessStale?: boolean;
  /** Override freshness unknown flag (issue #586) — falls back to context value */
  freshnessUnknown?: boolean;
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
  freshnessUnknown: propFreshnessUnknown,
  freshnessTooltip: propFreshnessTooltip,
}: TopBarProps) {
  const pathname = usePathname();
  const ctx = useFreshness();
  const freshnessText = propFreshnessText ?? ctx.freshnessText;
  const freshnessStale = propFreshnessStale ?? ctx.freshnessStale;
  // Issue #586 — fail dark, never green: an unknown state (DB error, or
  // nothing in scope) takes priority over both stale and refreshing below.
  const freshnessUnknown = propFreshnessUnknown ?? ctx.freshnessUnknown ?? false;
  const freshnessTooltip = propFreshnessTooltip ?? ctx.freshnessTooltip;
  // Refreshing (issue #295, D-050): a live cycle in progress, nothing stale —
  // shown with a distinct dot colour from both fresh (up) and stale (warn).
  const freshnessRefreshing = ctx.freshnessRefreshing && !freshnessStale && !freshnessUnknown;

  // Issue #571: mobile shell. At <768px the inline nav, Admin link and avatar
  // are hidden (Tailwind `hidden md:*` — display-only, never collides with
  // this component's inline styles) and replaced by a hamburger button that
  // opens a full-width panel listing the same destinations plus Admin. Menu
  // closes on link tap, outside tap, and Escape. Desktop (>=768px) is
  // untouched: same inline nav, same pixels.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Close on route change (link tap navigates -> pathname changes).
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Close on outside tap and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (menuPanelRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Wren nav link removed: WrenAI doesn't exist in this project (removed in
  // task 1.1). Paneles + Revisión removed (#101): both were the inherited
  // PowerShop generic dashboard-builder / weekly-business-review generator,
  // with no product fit for a real-estate investment-sourcing tool.
  // Conversaciones (free chat) stays — Phase 4 plans its own chat flow, and
  // the raw chat UI has reuse value independent of the dashboard-builder it
  // was originally paired with.
  // "Captura" (issue #268) is the top-level guided-capture EXECUTION surface,
  // deliberately placed next to Perfiles: the day-to-day loop (pick a profile →
  // open its pre-filtered searches → track capture progress) is a first-class
  // user task, not admin. SETUP (extension install, API key, connector config,
  // the raw worklist table) stays under /etl (Admin). See D-045 — Captura must
  // stay reachable top-level, including from the mobile hamburger menu below.
  // Issue #195: the standalone "Inicio" entry was dropped (owner-approved,
  // 2026-08-03). `/inicio` and `/` now render the same redesigned Perfiles
  // surface the "Perfiles" link points at, so a separate nav entry would be a
  // duplicate. The Perfiles link is marked active for `/`, `/inicio`, and
  // `/profiles` alike (see isActive below).
  const navLinks = [
    { href: "/profiles", label: "Perfiles" },
    { href: "/captura", label: "Captura" },
    { href: "/conversations", label: "Conversaciones" },
  ] as const;

  // Same active-route rule used by the desktop pills, reused by the mobile
  // menu rows (D-045: Admin must also be reachable, so it's appended here).
  function isActiveHref(href: string): boolean {
    if (href === "/profiles") {
      return pathname === "/" || pathname.startsWith("/inicio") || pathname.startsWith("/profiles");
    }
    return pathname.startsWith(href);
  }

  const menuLinks = [...navLinks, { href: "/admin", label: "Admin" }] as const;

  return (
    <header
      style={{ height: 56, borderBottom: "1px solid var(--border)", background: "var(--bg-1)" }}
      className="sticky top-0 z-20 flex items-center justify-between shrink-0"
    >
      {/* Left: logo + nav */}
      <div className="flex items-center gap-6 px-5">
        {/* Inmo-Tool bolt logo (shape kept from the source project, unbranded) */}
        <div className="flex items-center gap-1.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 2 L14 2 L20 11 L10 22 L4 22 L4 13 L11 13 L8 9 L4 9 Z" fill="var(--accent)" />
          </svg>
          {/* Wordmark: never wraps; hidden below md (issue #571) — the
              two-line "Inmo-"/"Tool" wrap was the widest single overflow
              source alongside the nav row. */}
          <span
            className="hidden md:inline"
            style={{
              fontFamily: "var(--font-inter), sans-serif",
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: "var(--fg)",
              whiteSpace: "nowrap",
            }}
          >
            Inmo-Tool
          </span>
        </div>

        {/* Primary nav — hidden below md, replaced by the hamburger menu */}
        <nav className="hidden md:flex items-center gap-1">
          {navLinks.map((link) => {
            const isExternal = "external" in link && link.external;
            const isActive = !isExternal && isActiveHref(link.href);
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

      {/* Right: status + cog + hamburger (mobile) + admin + avatar (desktop) */}
      <div className="flex items-center gap-3 px-5">
        {/* Live status */}
        <div
          className="flex items-center gap-1.5"
          title={freshnessTooltip ?? undefined}
        >
          <span
            role="status"
            // Issue #586 review (PR #590) — the dot is the ONLY thing
            // rendered below md (issue #571's text span is `display:none`
            // there, which drops it from the accessibility tree too, not
            // just visually), so it needs its own accessible name rather
            // than leaning on the sighted-only adjacent text or the
            // long-press-only `title` tooltip. `aria-live="polite"` only
            // announces when this label's text actually changes (a real
            // state transition), not on every silent 2-minute poll.
            aria-live="polite"
            aria-label={freshnessText || "Estado de los datos"}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              // Issue #586 — fail dark, never green: unknown (DB error, or
              // nothing in scope to assert about) takes priority over both
              // stale and refreshing, and is rendered in the same muted grey
              // used for secondary text elsewhere in this bar — never `--up`.
              background: freshnessUnknown
                ? "var(--fg-muted)"
                : freshnessStale
                  ? "var(--warn)"
                  : freshnessRefreshing
                    ? "var(--accent)"
                    : "var(--up)",
              animation: "pulse-dot 2s ease-in-out infinite",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          {/* Dot-only below md (issue #571): the dot always renders (colour
              semantics unchanged); the text is hidden on narrow viewports —
              "Datos desactualizados · hace 3h" alone was ~140px of the
              overflow. The `title` tooltip on the wrapper still carries the
              freshness timestamp for a mobile long-press. `aria-hidden`
              (issue #586 review): the dot above already carries this same
              text as its accessible name, so this stays visual-only rather
              than announcing it twice on desktop. */}
          <span
            data-testid="freshness-indicator"
            className="hidden md:inline"
            aria-hidden="true"
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

        {/* Hamburger — mobile only (issue #571). >=44x44 hit area for a
            thumb tap; toggles the menu panel below the header. The icon is
            centred by an inner span, not by `display` on the button itself:
            an inline `display` on this element would beat the `md:hidden`
            Tailwind class that hides it at >=768px (inline styles win over
            Tailwind for the same property — see the constraint on this
            component), which is exactly what happened during development. */}
        <button
          ref={menuButtonRef}
          type="button"
          className="md:hidden"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menú"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-panel"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-muted)",
            width: 44,
            height: 44,
            borderRadius: 6,
            marginRight: -10,
            padding: 0,
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </span>
        </button>

        {/* Admin link — hidden below md, folded into the hamburger menu */}
        <Link
          href="/admin"
          className="hidden md:inline"
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

        {/* Avatar — hidden below md (decorative, saves space) */}
        <div
          className="hidden md:flex"
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            fontSize: 11,
            fontWeight: 600,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
          aria-label="Avatar de usuario"
        >
          AL
        </div>
      </div>

      {/* Mobile nav panel — anchored under the 56px header, mobile only.
          Only ever mounted while open, so it never affects desktop. */}
      {menuOpen && (
        <>
        {/* Invisible backdrop. Without it the outside-tap-to-dismiss handler
            closes the menu on mousedown/touchstart but nothing swallows the
            subsequent click, so the tap ALSO activates whatever is underneath
            — reproduced on a real touch tap: dismissing the menu over the feed
            navigated into a profile. On a phone, "tap elsewhere to close" is
            the natural gesture, so it would misfire constantly. Rendered with
            the panel, below it in z-order (PR #578 review, finding 1). */}
        <div
          data-testid="mobile-nav-backdrop"
          className="md:hidden"
          onClick={() => setMenuOpen(false)}
          style={{
            position: "fixed",
            top: 56,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 29,
          }}
        />
        <div
          id="mobile-nav-panel"
          ref={menuPanelRef}
          role="navigation"
          aria-label="Menú principal"
          className="md:hidden"
          style={{
            position: "fixed",
            top: 56,
            left: 0,
            right: 0,
            zIndex: 30,
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--border)",
            boxShadow: "0 8px 16px rgba(0, 0, 0, 0.15)",
          }}
        >
          {menuLinks.map((link) => {
            const isActive = isActiveHref(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  minHeight: 44,
                  padding: "12px 20px",
                  fontSize: 15,
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? "var(--fg)" : "var(--fg-muted)",
                  background: isActive ? "var(--bg-2)" : "transparent",
                  textDecoration: "none",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        </>
      )}
    </header>
  );
}
