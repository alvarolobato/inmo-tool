"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { MATCH_BASIS_LABELS, MATCH_BASES, type DedupSuggestion, type DedupSuggestionCounts, type MatchBasis } from "@/lib/dedup-shared";
import { SuggestionCard } from "./SuggestionCard";

interface ListResponse {
  items: DedupSuggestion[];
  counts: DedupSuggestionCounts;
  nextOffset: number | null;
}

/**
 * The dedup review queue (the "missing half" of the dedup workflow — see
 * lib/dedup.ts's module docstring). One card per pending `suggested_merge`
 * row, strongest evidence first.
 *
 * Filter chips (issue: 527 of 585 pending suggestions are `fuzzy` at ~0.585
 * average confidence — mostly noise; 52 are `photo_hash` at ~0.78, the
 * high-value ones) let an operator jump straight past the fuzzy tail rather
 * than clicking "siguiente" 500 times before reaching a photo match. The
 * default sort (confidence DESC, see lib/dedup.ts) already surfaces
 * photo_hash/reference_code/phone ahead of fuzzy even with no filter
 * applied — the chips are for deliberately narrowing, not for making the
 * strong evidence reachable at all.
 */
export function SuggestionQueue() {
  const [items, setItems] = useState<DedupSuggestion[]>([]);
  const [counts, setCounts] = useState<DedupSuggestionCounts>({ total: 0, by_basis: {}, profile_relevant_total: 0 });
  const [basis, setBasis] = useState<MatchBasis | null>(null);
  // "solo mis perfiles" toggle (issue #246). Default false = "ver todos": show
  // the whole queue with profile-relevant pairs sorted first (nothing hidden).
  const [onlyProfileRelevant, setOnlyProfileRelevant] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      const url = new URL("/api/dedup/suggestions", window.location.origin);
      if (basis) url.searchParams.set("basis", basis);
      if (onlyProfileRelevant) url.searchParams.set("profile", "relevant");
      url.searchParams.set("offset", String(offset));
      const res = await fetch(url.toString().replace(window.location.origin, ""));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "Error al cargar la cola de duplicados.");
        return;
      }
      const page: ListResponse = await res.json();
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
      setCounts(page.counts);
      setNextOffset(page.nextOffset);
    },
    [basis, onlyProfileRelevant],
  );

  useEffect(() => {
    setItems([]);
    setNextOffset(null);
    setError(null);
    setLoading(true);
    fetchPage(0, true).finally(() => setLoading(false));
  }, [fetchPage]);

  const loadMore = async () => {
    if (nextOffset === null) return;
    setLoadingMore(true);
    try {
      await fetchPage(nextOffset, false);
    } finally {
      setLoadingMore(false);
    }
  };

  // A resolved suggestion (confirmed or rejected) drops out of the queue
  // immediately — no need to re-fetch the whole list for one row, and the
  // per-chip counts decrement to match without a round trip.
  const handleResolved = (suggestionId: number) => {
    setItems((prev) => prev.filter((s) => s.id !== suggestionId));
    setCounts((prev) => {
      const resolved = items.find((s) => s.id === suggestionId);
      if (!resolved) return prev;
      const nextByBasis = { ...prev.by_basis };
      const current = nextByBasis[resolved.match_basis] ?? 0;
      if (current > 0) nextByBasis[resolved.match_basis] = current - 1;
      // Keep profile_relevant_total in sync using the resolved row's own flag,
      // so the "N relevantes" figure decrements without a refetch.
      const nextRelevant = resolved.profile_relevant
        ? Math.max(0, prev.profile_relevant_total - 1)
        : prev.profile_relevant_total;
      return {
        total: Math.max(0, prev.total - 1),
        by_basis: nextByBasis,
        profile_relevant_total: nextRelevant,
      };
    });
  };

  if (loading) {
    return <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando cola de duplicados…</p>;
  }

  if (error) {
    return <ErrorDisplay error={error} className="mt-4" />;
  }

  const basesWithCounts = MATCH_BASES.filter((b) => (counts.by_basis[b] ?? 0) > 0);

  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}
        data-testid="dedup-profile-toggle"
      >
        <button
          type="button"
          data-testid="dedup-toggle-all"
          onClick={() => setOnlyProfileRelevant(false)}
          style={chipStyle(!onlyProfileRelevant)}
        >
          Ver todos ({counts.total})
        </button>
        <button
          type="button"
          data-testid="dedup-toggle-relevant"
          onClick={() => setOnlyProfileRelevant(true)}
          style={chipStyle(onlyProfileRelevant)}
        >
          Solo mis perfiles ({counts.profile_relevant_total})
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }} data-testid="dedup-filter-chips">
        <button
          type="button"
          data-testid="dedup-filter-all"
          onClick={() => setBasis(null)}
          style={chipStyle(basis === null)}
        >
          Todas ({counts.total})
        </button>
        {basesWithCounts.map((b) => (
          <button
            key={b}
            type="button"
            data-testid={`dedup-filter-${b}`}
            onClick={() => setBasis(b)}
            style={chipStyle(basis === b)}
          >
            {MATCH_BASIS_LABELS[b]} ({counts.by_basis[b]})
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p data-testid="dedup-empty-state" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          {counts.total === 0
            ? "No hay sugerencias de duplicados pendientes de revisión."
            : onlyProfileRelevant
              ? "No hay sugerencias pendientes relevantes para tus perfiles activos. Cambia a «Ver todos» para revisar el resto de la cola."
              : "No hay sugerencias pendientes para este tipo de coincidencia."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} onResolved={handleResolved} />
          ))}
        </div>
      )}

      {nextOffset !== null && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            alignSelf: "flex-start",
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

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--fg-muted)",
    cursor: "pointer",
  };
}
