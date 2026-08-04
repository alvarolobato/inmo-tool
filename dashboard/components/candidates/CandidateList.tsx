"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { CandidateRow } from "@/lib/candidates";
import { COLD_START_EXPLANATION } from "@/lib/scoring/cold-start";
import { CandidateCard } from "./CandidateCard";
import { ZeroCandidatesDiagnostic } from "@/components/profiles/ZeroCandidatesDiagnostic";

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
  // Source (portal) filter (#265). `source === null` means "all portals".
  // The options are the sources this profile's candidates actually carry
  // (GET .../candidate-sources), fetched once and kept stable while the feed
  // pages — so the dropdown never offers a portal that would match nothing.
  const [source, setSource] = useState<string | null>(null);
  const [availableSources, setAvailableSources] = useState<string[]>([]);

  const fetchPage = useCallback(
    async (afterCursor: string | null, replace: boolean) => {
      const url = new URL(`/api/profiles/${profileId}/candidates`, window.location.origin);
      if (afterCursor !== null) url.searchParams.set("cursor", afterCursor);
      // Combines with pagination (cursor) rather than replacing it (#265).
      if (source !== null) url.searchParams.set("source", source);
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
    [profileId, source],
  );

  // Load the portal options once per profile (independent of the active
  // filter, so switching sources never shrinks the dropdown to the current
  // selection). Best-effort: a failure here just leaves the filter hidden —
  // the feed itself still works.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/profiles/${profileId}/candidate-sources`)
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body: { sources?: string[] } | null) => {
        if (!cancelled && body && Array.isArray(body.sources)) {
          setAvailableSources(body.sources);
        }
      })
      .catch(() => {
        /* non-fatal: filter simply won't render */
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // Re-runs on profile OR source change (fetchPage's identity depends on
  // both) — resetting the feed to page 1 whenever the filter changes.
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

  // The source filter must render in EVERY state (loading/error/empty/
  // populated), not just alongside a full grid — otherwise narrowing to a
  // portal with zero candidates would early-return the empty state and hide
  // the very control the user needs to clear the filter. Rendered once here,
  // above whatever body the state below produces. Hidden when the profile has
  // no sources at all (nothing to filter).
  const filterBar =
    availableSources.length > 0 ? (
      <div
        data-testid="source-filter-bar"
        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, flexWrap: "wrap" }}
      >
        <label htmlFor="candidate-source-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Fuente
        </label>
        <select
          id="candidate-source-filter"
          data-testid="source-filter"
          value={source ?? ""}
          onChange={(e) => setSource(e.target.value === "" ? null : e.target.value)}
          style={{
            padding: "5px 8px",
            fontSize: 13,
            color: "var(--fg)",
            background: "var(--bg-1)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            textTransform: "capitalize",
          }}
        >
          <option value="">Todas las fuentes</option>
          {availableSources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    ) : null;

  if (loading) {
    return (
      <div>
        {filterBar}
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>Cargando candidatos…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {filterBar}
        <ErrorDisplay error={error} className="mt-4" />
      </div>
    );
  }

  if (items.length === 0) {
    // When a source filter is active, an empty feed means "no candidates from
    // this portal", NOT that the profile itself has none — so the
    // ZeroCandidatesDiagnostic (which explains why a whole profile has no
    // candidates) would be misleading here. Show a filter-scoped message
    // instead, keeping the filter bar so the user can clear it.
    if (source !== null) {
      return (
        <div>
          {filterBar}
          <p data-testid="no-candidates-for-source" style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>
            No hay candidatos de esta fuente. Cambia o quita el filtro para ver el resto.
          </p>
        </div>
      );
    }
    // Issue #194: the shared diagnostic replaces this generic, cause-free
    // message — it tells the operator WHICH of never-materialized/
    // geography/type/price/exclusion/stale-materialization is actually true,
    // rather than "prueba a ampliar los filtros" for every possible cause.
    return (
      <div style={{ marginTop: 16 }}>
        {filterBar}
        <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>Este perfil no tiene candidatos.</p>
        <ZeroCandidatesDiagnostic profileId={profileId} />
      </div>
    );
  }

  // The cold-start explanation is the same sentence on every candidate of an
  // unpersonalized profile, so it belongs to the *profile*, not to any card
  // (#152). Shown once below the grid; disappears on its own as soon as the
  // profile has a trained model and the per-property explanations take over.
  //
  // Detected via the durable `score_kind` marker, not by comparing
  // `rank_explanation` against the constant string (#152 review): that
  // string is *persisted* on `profile_listing_state` at scoring time, so a
  // purely cosmetic copy edit to COLD_START_EXPLANATION would silently stop
  // matching every already-written row and un-suppress the old sentence.
  const coldStart = items.some((c) => c.score_kind === "cold_start");

  return (
    <div>
      {filterBar}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
          marginTop: 16,
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
