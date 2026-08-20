"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import {
  MATCH_BASIS_LABELS,
  MATCH_BASES,
  type DedupPropertyPairCounts,
  type DedupPropertyPairSuggestion,
  type MatchBasis,
} from "@/lib/dedup-shared";
import { PropertyPairCard } from "./PropertyPairCard";

interface ListResponse {
  items: DedupPropertyPairSuggestion[];
  counts: DedupPropertyPairCounts;
  nextOffset: number | null;
}

/**
 * The dedup review queue, grouped by PROPERTY pair (issue #605 Part 2 —
 * supersedes the old per-listing-pair `SuggestionQueue`). #600 measured 892
 * pending listing-pair rows collapsing to 669 distinct property-pair
 * questions; one property pair alone had 38 identical listing-pair rows,
 * because property A with 6 listings and property B with 7 produce up to
 * 42 listing-pair combinations all asking "is A the same property as B?".
 * One card per group here, not one per listing-pair row.
 *
 * Filter chips and the "solo mis perfiles" toggle keep the same semantics
 * as the old flat queue (see lib/dedup.ts's `listDedupPropertyPairSuggestions`
 * docstring for the one difference: a basis filter narrows to GROUPS
 * containing at least one row of that basis, but each group still shows
 * its FULL evidence — nothing is hidden by narrowing).
 */
export function PropertyPairQueue() {
  const [items, setItems] = useState<DedupPropertyPairSuggestion[]>([]);
  const [counts, setCounts] = useState<DedupPropertyPairCounts>({ total: 0, by_basis: {}, profile_relevant_total: 0 });
  const [basis, setBasis] = useState<MatchBasis | null>(null);
  const [onlyProfileRelevant, setOnlyProfileRelevant] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      const url = new URL("/api/dedup/property-pairs", window.location.origin);
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

  // A resolved group drops out immediately — no full refetch for one card.
  // Per-chip counts are harder to keep exact here (a group can carry
  // several bases, see DedupPropertyPairCounts's docstring), so this
  // decrements `total`/`profile_relevant_total` precisely and every basis
  // the resolved group touched by 1 each — correct for the common case (a
  // basis bucket never goes negative or double-counts a still-pending
  // group), and a stale-by-a-little chip count self-heals on the next
  // filter click anyway (fetchPage always refreshes `counts` from the
  // server).
  const handleResolved = (pairKey: string) => {
    setItems((prev) => prev.filter((p) => p.pair_key !== pairKey));
    setCounts((prev) => {
      const resolved = items.find((p) => p.pair_key === pairKey);
      if (!resolved) return prev;
      const nextByBasis = { ...prev.by_basis };
      const bases = new Set(resolved.evidence.map((e) => e.match_basis));
      for (const b of bases) {
        const current = nextByBasis[b] ?? 0;
        if (current > 0) nextByBasis[b] = current - 1;
      }
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
          {items.map((p) => (
            <PropertyPairCard key={p.pair_key} pair={p} onResolved={handleResolved} />
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
