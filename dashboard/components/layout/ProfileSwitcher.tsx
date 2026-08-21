"use client";

/**
 * Profile switcher (task 2.5, #19) — lets the investor jump between search
 * profiles from within the candidate feed. Distinct from the top-nav
 * `/profiles` link (task 2.3), which goes to the profile CRUD/list page;
 * this is a scoped selector that lives on the candidate feed itself and
 * navigates between `/profiles/[id]` feed views.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchProfileRow } from "@/lib/profiles-schema";

export function ProfileSwitcher({
  currentId,
  subpath = "",
}: {
  currentId: number;
  /**
   * Path segment appended after `/profiles/[id]` on select. Default "" goes to
   * that profile's candidate feed; the "Validar filtros" page passes
   * "/filtros" so the switcher keeps you on that page. A string (not a
   * function) so it can cross the server→client component boundary.
   */
  subpath?: string;
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<SearchProfileRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profiles")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: SearchProfileRow[]) => {
        if (!cancelled) setProfiles(data);
      })
      .catch(() => {
        // Best-effort: if the profile list can't be fetched, the switcher
        // just doesn't render — the candidate feed below still works fine
        // for the profile the page was already loaded for.
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (profiles === null || profiles.length === 0) {
    return null;
  }

  // A native <select> whose `value` doesn't match any <option> silently
  // falls back to displaying the *first* option — so navigating to an
  // unknown/deleted profile id was showing a real (wrong) profile's name
  // instead of indicating "not found". Prepend an explicit placeholder for
  // that case rather than let the browser pick one for us.
  const currentExists = profiles.some((p) => p.id === currentId);

  return (
    <select
      value={currentId}
      onChange={(e) => router.push(`/profiles/${e.target.value}${subpath}`)}
      style={{
        // #574: a native <select> sizes to its longest <option> (an
        // owner-controlled profile name) with no intrinsic cap — on a
        // phone that alone pushed `main.main-content`'s own scrollWidth
        // (its `overflow: auto` from the #571 mobile shell) past its
        // clientWidth, which reads as sideways scroll on the content pane
        // even though `document.documentElement` never overflowed.
        // `min(220px, 60vw)` caps it at both ends: a normal name never
        // shrinks below 220px on a wide screen, and a phone never lets it
        // exceed 60% of the viewport regardless of name length.
        padding: "6px 10px",
        background: "var(--bg-1)",
        color: "var(--fg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 13,
        maxWidth: "min(220px, 60vw)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      aria-label="Cambiar de perfil de búsqueda"
    >
      {!currentExists && (
        <option value={currentId} disabled>
          Perfil no encontrado
        </option>
      )}
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
