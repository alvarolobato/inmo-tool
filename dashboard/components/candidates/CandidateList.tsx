"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { CandidateRow } from "@/lib/candidates";
import { COLD_START_EXPLANATION } from "@/lib/scoring/cold-start";
import { CandidateCard } from "./CandidateCard";

/**
 * Candidate feed for one profile (task 2.5, #19) — one card per property,
 * cursor-paginated. Task 3.4 (#23): globally ordered best-score-first across
 * pages (server-side `ORDER BY score DESC NULLS LAST, id DESC`, see
 * lib/candidates.ts) — the cursor is an opaque string carrying both score
 * and id so pagination stays correct under that compound sort; this
 * component never inspects or constructs cursor values itself.
 */
export function CandidateList({ profileId }: { profileId: number }) {
  const [items, setItems] = useState<CandidateRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchPage = useCallback(
    async (afterCursor: string | null, replace: boolean) => {
      const url = new URL(`/api/profiles/${profileId}/candidates`, window.location.origin);
      if (afterCursor !== null) url.searchParams.set("cursor", afterCursor);
      const res = await fetch(url.toString().replace(window.location.origin, ""));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "Error al cargar los candidatos.");
        return;
      }
      const page: { items: CandidateRow[]; nextCursor: string | null } = await res.json();
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

  // The cold-start explanation is the same sentence on every candidate of an
  // unpersonalized profile, so it belongs to the *profile*, not to any card
  // (#152). Shown once below the grid; disappears on its own as soon as the
  // profile has a trained model and the per-property explanations take over.
  const coldStart = items.some((c) => c.rank_explanation === COLD_START_EXPLANATION);

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

      {coldStart && (
        <p
          data-testid="cold-start-footer"
          style={{
            marginTop: 16,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-1)",
            fontSize: 12,
            color: "var(--fg-muted)",
          }}
        >
          {COLD_START_EXPLANATION}
        </p>
      )}
    </div>
  );
}
