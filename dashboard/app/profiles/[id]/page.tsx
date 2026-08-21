"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { SearchProfileRow } from "@/lib/profiles-schema";
import { ProfileSwitcher } from "@/components/layout/ProfileSwitcher";
import { CandidateList } from "@/components/candidates/CandidateList";

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function ProfileCandidateFeedPage() {
  const params = useParams<{ id: string }>();
  const id = parseId(params.id);

  const [profile, setProfile] = useState<SearchProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/profiles/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw isApiErrorResponse(body) ? body : new Error("Perfil no encontrado.");
        }
        return res.json();
      })
      .then((data: SearchProfileRow) => {
        if (!cancelled) setProfile(data);
      })
      .catch((err) => {
        if (!cancelled) setError(isApiErrorResponse(err) ? err : "No se pudo cargar el perfil.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (id === null) {
    return (
      <div style={{ width: "100%", padding: "16px clamp(16px, 2vw, 40px) 32px" }}>
        <ErrorDisplay error="Id de perfil no válido." />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", padding: "16px clamp(16px, 2vw, 40px) 32px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <Link href="/profiles" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            ← Perfiles de búsqueda
          </Link>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--fg)", margin: "4px 0 0" }}>
            {loading ? "Cargando…" : profile?.name ?? "Perfil"}
          </h1>
        </div>
        {/* #574: this row used to be non-wrapping (default flex nowrap) — a
            long profile name in ProfileSwitcher's <select> pushed it past
            the viewport, which `main.main-content`'s own `overflow: auto`
            (from the #571 mobile shell) turned into real sideways scroll
            on the content pane. flexWrap lets "Ver mapa →" drop to its own
            line below the switcher on a narrow phone instead; combined
            with the switcher's own width cap, this row never needs to. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Link href={`/profiles/${id}/map`} style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            Ver mapa →
          </Link>
          <ProfileSwitcher currentId={id} />
        </div>
      </div>

      {error && <ErrorDisplay error={error} className="mt-4" />}

      {!loading && !error && profile?.archived_at !== null && profile !== null && (
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
          Este perfil está archivado y ya no tiene candidatos activos.
        </p>
      )}

      {!loading && !error && profile !== null && profile.archived_at === null && (
        <CandidateList profileId={id} />
      )}
    </div>
  );
}
