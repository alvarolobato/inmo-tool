"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { MapCandidateRow } from "@/lib/map-candidates";

/**
 * Leaflet touches `window` at import time — must be loaded client-only.
 * Rendering it inside a Next.js SSR pass (even one wrapped in "use client",
 * which still SSRs on first render) throws immediately. This is the fix for
 * exactly the "works in a component test, breaks in the real browser" bug
 * class this project has hit three times before in the dashboard.
 */
const CandidateMap = dynamic(
  () => import("./CandidateMap").then((mod) => mod.CandidateMap),
  { ssr: false, loading: () => <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando mapa…</p> },
);

interface MapCandidatesResponse {
  items: MapCandidateRow[];
  unplottableCount: number;
  truncated: boolean;
}

export function MapView({ profileId }: { profileId: number }) {
  const [data, setData] = useState<MapCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/profiles/${profileId}/map`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw isApiErrorResponse(body) ? body : new Error("Error al cargar el mapa.");
        }
        return res.json();
      })
      .then((body: MapCandidatesResponse) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(isApiErrorResponse(err) ? err : "No se pudo cargar el mapa de candidatos.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  if (loading) {
    return <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando mapa…</p>;
  }

  if (error) {
    return <ErrorDisplay error={error} className="mt-4" />;
  }

  if (data === null || (data.items.length === 0 && data.unplottableCount === 0)) {
    return (
      <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
        Este perfil no tiene candidatos todavía. Prueba a ampliar los filtros o espera a que se ingieran más
        anuncios.
      </p>
    );
  }

  return (
    <CandidateMap
      candidates={data.items}
      unplottableCount={data.unplottableCount}
      truncated={data.truncated}
      profileId={profileId}
    />
  );
}
