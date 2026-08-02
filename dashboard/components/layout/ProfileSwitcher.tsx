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

export function ProfileSwitcher({ currentId }: { currentId: number }) {
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

  return (
    <select
      value={currentId}
      onChange={(e) => router.push(`/profiles/${e.target.value}`)}
      style={{
        padding: "6px 10px",
        background: "var(--bg-1)",
        color: "var(--fg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 13,
      }}
      aria-label="Cambiar de perfil de búsqueda"
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
