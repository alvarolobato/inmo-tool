"use client";

import { summarizeNovedades } from "@/lib/novedades";
import type { ProfileOverviewEntry } from "@/lib/profile-overview-types";

/**
 * The "novedades" strip (issue #195) — a one-line, page-level glance above the
 * Perfiles rows answering the one "home" question that doesn't fit a
 * per-profile row: *what appeared across all my profiles since I last looked.*
 * This is the first thing a busy investor sees each day; it replaces the dead
 * Phase-1 `/inicio` placeholder that #195 retired.
 *
 * When there are new candidates it renders a clickable strip
 * ("N perfiles con candidatos nuevos desde tu última visita · M nuevos en
 * total") that jumps to / highlights the profile that changed the most. When
 * there is nothing new it renders a quiet "Sin novedades" line rather than a
 * gap, so the surface never reads as broken.
 *
 * No data of its own: it summarizes the same `ProfileOverviewEntry[]` the page
 * already fetched (see lib/novedades.ts) — the strip's total and each row's
 * "N nuevos" therefore always agree.
 */
export function NovedadesStrip({
  overviews,
  onJumpToProfile,
}: {
  /** The Perfiles overview entries, or `null` in the degraded fallback (no `new_count` available — the strip then renders nothing). */
  overviews: ProfileOverviewEntry[] | null;
  /** Jump-to handler: scrolls to and highlights the given profile's row. */
  onJumpToProfile: (profileId: number) => void;
}) {
  // Degraded fallback: the heavier aggregate failed and only the plain list
  // loaded — there is no new_count to summarize, so render nothing rather than
  // a misleading "sin novedades".
  if (overviews === null) return null;

  const { totalNew, profilesWithNew, newProfileIds } = summarizeNovedades(overviews);

  if (totalNew === 0) {
    return (
      <div
        data-testid="novedades-strip-empty"
        style={{
          marginTop: 16,
          padding: "10px 14px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-1)",
          fontSize: 13,
          color: "var(--fg-muted)",
        }}
      >
        Sin novedades desde tu última visita.
      </div>
    );
  }

  const profilesLabel =
    profilesWithNew === 1
      ? "1 perfil con candidatos nuevos"
      : `${profilesWithNew} perfiles con candidatos nuevos`;
  const totalLabel = totalNew === 1 ? "1 nuevo en total" : `${totalNew} nuevos en total`;

  return (
    <button
      type="button"
      data-testid="novedades-strip"
      data-total-new={totalNew}
      data-profiles-with-new={profilesWithNew}
      onClick={() => onJumpToProfile(newProfileIds[0])}
      style={{
        marginTop: 16,
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        borderRadius: 8,
        border: "1px solid var(--accent)",
        background: "var(--accent-soft)",
        color: "var(--fg)",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--up)",
          flexShrink: 0,
          animation: "pulse-dot 2s ease-in-out infinite",
        }}
      />
      <span>
        <strong style={{ color: "var(--accent)" }}>{profilesLabel}</strong> desde tu última
        visita · {totalLabel}
      </span>
      <span aria-hidden style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 600 }}>
        →
      </span>
    </button>
  );
}
