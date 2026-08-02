"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { CandidateRow } from "@/lib/candidates";
import { CandidateCard } from "./CandidateCard";

/**
 * Candidate feed for one profile (task 2.5, #19) — one card per property,
 * cursor-paginated. No scoring/ranking yet (Phase 3): default order is
 * most-recently-materialized property first (server-side `ORDER BY id DESC`,
 * see lib/candidates.ts), a reasonable placeholder until Phase 3's score
 * exists to order by instead.
 */
export function CandidateList({ profileId }: { profileId: number }) {
  const [items, setItems] = useState<CandidateRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchPage = useCallback(
    async (afterCursor: number | null, replace: boolean) => {
      const url = new URL(`/api/profiles/${profileId}/candidates`, window.location.origin);
      if (afterCursor !== null) url.searchParams.set("cursor", String(afterCursor));
      const res = await fetch(url.toString().replace(window.location.origin, ""));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "Error al cargar los candidatos.");
        return;
      }
      const page: { items: CandidateRow[]; nextCursor: number | null } = await res.json();
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
    },
    [profileId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setError(null);
    setLoading(true);
    fetchPage(null, true).finally(() => setLoading(false));
  }, [fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await fetchPage(cursor, false);
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando candidatos…</p>;
  }

  if (error) {
    return <ErrorDisplay error={error} className="mt-4" />;
  }

  if (items.length === 0) {
    return (
      <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
        Este perfil no tiene candidatos todavía. Prueba a ampliar los filtros o espera a que se ingieran más
        anuncios.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((c) => (
          <CandidateCard key={c.property_id} candidate={c} profileId={profileId} />
        ))}
      </div>

      {cursor !== null && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            marginTop: 16,
            padding: "7px 14px",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--fg)",
            cursor: loadingMore ? "default" : "pointer",
            opacity: loadingMore ? 0.6 : 1,
          }}
        >
          {loadingMore ? "Cargando…" : "Cargar más"}
        </button>
      )}
    </div>
  );
}
