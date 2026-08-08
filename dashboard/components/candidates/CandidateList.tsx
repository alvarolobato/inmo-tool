"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { CandidateRow } from "@/lib/candidates";
import { COLD_START_EXPLANATION } from "@/lib/scoring/cold-start";
import { CandidateCard } from "./CandidateCard";
import { CandidateFilterBar } from "./CandidateFilterBar";
import { ZeroCandidatesDiagnostic } from "@/components/profiles/ZeroCandidatesDiagnostic";
import {
  DEFAULT_CANDIDATE_FILTERS,
  candidateFiltersToSearch,
  parseCandidateFilters,
  showRejectedFromView,
  trackedOnlyFromView,
  type CandidateFilters,
} from "@/lib/candidate-filters";

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
  // #425: when the novelty tier was suppressed for this session (profile never
  // visited, or the tier would cover >60% of the matched pool), show one line
  // instead of painting the whole feed as "new" (plan #415 §3.2 cold-start).
  const [noveltyColdStart, setNoveltyColdStart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const router = useRouter();

  // #465 (Feed UX F2): all feed filters live in ONE object, sourced from the
  // page URL (query params on /profiles/[id]) instead of per-filter useState —
  // so the feed supports deep-links, back/forward, and the Fase-4 click-through.
  // Semantics/vocabulary of every filter are preserved bit-for-bit (D-059
  // filter⇔rank invariant); only the state SOURCE changed. Serialization lives
  // in lib/candidate-filters.ts. Individual filter meanings:
  //   - source (#265): portal filter, null = all.
  //   - occupancy/conditionSel (#310), caveat/redflagType (#386),
  //     beachProximity/heritageZone (#392), isVpo (#398): AI-gated hard filters
  //     (empty until assessment data flows — folded into assessmentFilterActive
  //     so the empty state says "needs assessment", not "broken").
  //   - minDiscount (#310): below-market %, computed from price, works today.
  //   - view (#422/#379): the 3 reachable preset states (all / seguimiento /
  //     descartadas) that were two mutually-exclusive checkboxes.
  const [filters, setFilters] = useState<CandidateFilters>(
    DEFAULT_CANDIDATE_FILTERS,
  );
  const {
    source,
    occupancy,
    conditionSel,
    minDiscount,
    caveat,
    redflagType,
    beachProximity,
    heritageZone,
    isVpo,
    view,
  } = filters;
  // Derived from the segmented `view`: what the fetch layer / card rendering
  // used to read off two booleans.
  const trackedOnly = trackedOnlyFromView(view);
  const showRejected = showRejectedFromView(view);

  // The options are the sources this profile's candidates actually carry
  // (GET .../candidate-sources), fetched once and kept stable while the feed
  // pages — so the dropdown never offers a portal that would match nothing.
  const [availableSources, setAvailableSources] = useState<string[]>([]);
  // #428: in-app "En seguimiento" indicator — count of tracked (accept)
  // properties with a sanity-banded price DROP in the recent window
  // (GET .../seguimiento-alerts). Backs the small count on the seguimiento
  // segment so the owner sees at a glance that something he tracks has moved.
  // Best-effort: a failed fetch leaves the count at 0 (no badge).
  const [seguimientoAlertCount, setSeguimientoAlertCount] = useState(0);

  // Read the filters out of the URL once on mount (SSR-safe: starts at the
  // defaults, corrected on the client) — same window.location precedent as the
  // property-detail page (avoids the useSearchParams Suspense boundary).
  useEffect(() => {
    setFilters(parseCandidateFilters(window.location.search));
  }, []);

  // Single writer: update state AND mirror it into the URL with router.replace
  // (no history spam, no scroll jump). fetchPage's identity depends on the
  // primitive fields, so this transparently resets the feed to page 1.
  const updateFilters = useCallback(
    (next: CandidateFilters) => {
      setFilters(next);
      router.replace(`/profiles/${profileId}${candidateFiltersToSearch(next)}`, {
        scroll: false,
      });
    },
    [router, profileId],
  );

  const assessmentFilterActive =
    occupancy !== "" ||
    conditionSel !== "" ||
    caveat !== "" ||
    redflagType !== "" ||
    beachProximity !== "" ||
    heritageZone ||
    isVpo !== "";

  const fetchPage = useCallback(
    async (afterCursor: string | null, replace: boolean) => {
      const url = new URL(
        `/api/profiles/${profileId}/candidates`,
        window.location.origin,
      );
      if (afterCursor !== null) url.searchParams.set("cursor", afterCursor);
      // Combines with pagination (cursor) rather than replacing it (#265).
      if (source !== null) url.searchParams.set("source", source);
      // #310 filters. `conditionSel` splits into condition + renovation params.
      if (occupancy !== "") url.searchParams.set("occupancy", occupancy);
      if (conditionSel !== "") {
        const [cond, sev] = conditionSel.split(":");
        url.searchParams.set("condition", cond);
        if (sev) url.searchParams.set("renovation", sev);
      }
      if (minDiscount !== "") url.searchParams.set("minDiscount", minDiscount);
      // #386 caveat / redflag-type filters.
      if (caveat !== "") url.searchParams.set("caveat", caveat);
      if (redflagType !== "") url.searchParams.set("redflagType", redflagType);
      // #392 beach-proximity (min grade) + casco-histórico toggle.
      if (beachProximity !== "")
        url.searchParams.set("beachProximity", beachProximity);
      if (heritageZone) url.searchParams.set("heritageZone", "true");
      // #398 VPO (bidirectional): "true" only VPO, "false" exclude VPO.
      if (isVpo !== "") url.searchParams.set("isVpo", isVpo);
      // #379: opt in to rejected candidates. Omitted (default) keeps them hidden.
      if (showRejected) url.searchParams.set("includeRejected", "true");
      // #422: "En seguimiento" preset — restrict to tracked (accepted) properties.
      if (trackedOnly) url.searchParams.set("state", "accept");
      const res = await fetch(
        url.toString().replace(window.location.origin, ""),
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          isApiErrorResponse(body) ? body : "Error al cargar los candidatos.",
        );
        return;
      }
      const page: {
        items: CandidateRow[];
        nextCursor: string | null;
        coldStart?: boolean;
      } = await res.json();
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
      // #425: the novelty cold-start suppression decision is session-fixed
      // (resolved on page 1, threaded through the cursor), so only the page-1
      // (replace) response carries the authoritative value — a "Cargar más"
      // append must not clobber it.
      if (replace) setNoveltyColdStart(page.coldStart === true);
    },
    [
      profileId,
      source,
      occupancy,
      conditionSel,
      minDiscount,
      caveat,
      redflagType,
      beachProximity,
      heritageZone,
      isVpo,
      showRejected,
      trackedOnly,
    ],
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

  // #428: fetch the in-app "En seguimiento" alert count once per profile.
  // Best-effort — a failure leaves the count at 0 (no badge shown).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/profiles/${profileId}/seguimiento-alerts`)
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body: { count?: number } | null) => {
        if (!cancelled && body && typeof body.count === "number") {
          setSeguimientoAlertCount(body.count);
        }
      })
      .catch(() => {
        /* non-fatal: the indicator simply won't show */
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

  // The filter bar (#465) must render in EVERY state
  // (loading/error/empty/populated), not just alongside a full grid —
  // otherwise narrowing to a filter with zero candidates would early-return the
  // empty state and hide the very controls the user needs to clear the filter.
  // Rendered once here, above whatever body the state below produces.
  const filterBar = (
    <CandidateFilterBar
      values={filters}
      onChange={updateFilters}
      availableSources={availableSources}
      seguimientoAlertCount={seguimientoAlertCount}
    />
  );

  if (loading) {
    return (
      <div>
        {filterBar}
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)" }}>
          Cargando candidatos…
        </p>
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
    // #310 graceful degradation: an occupancy/condition filter reads AI
    // assessment data that is empty until #316 wires the LLM, so an empty feed
    // here does NOT mean the profile has no candidates — it means no candidate
    // has been assessed yet. Say so explicitly rather than showing empty as if
    // broken, and keep the bar so the user can clear the filter. Checked before
    // the source/diagnostic branches because this is the more specific cause.
    if (assessmentFilterActive) {
      return (
        <div>
          {filterBar}
          <p
            data-testid="no-candidates-needs-assessment"
            style={{
              marginTop: 16,
              fontSize: 13,
              color: "var(--fg-muted)",
              margin: 0,
            }}
          >
            No hay candidatos con estos criterios. Los filtros de ocupación y
            estado usan datos de evaluación de la IA, que aún no están
            disponibles para estas propiedades. Quita el filtro para ver el
            resto.
          </p>
        </div>
      );
    }
    // #422: the "En seguimiento" preset is on but nothing is tracked yet. Not a
    // broken feed and not a missing-data case — the user simply hasn't accepted
    // any property. Say so and keep the bar so they can turn the preset off.
    if (trackedOnly) {
      return (
        <div>
          {filterBar}
          <p
            data-testid="no-candidates-tracked"
            style={{
              marginTop: 16,
              fontSize: 13,
              color: "var(--fg-muted)",
              margin: 0,
            }}
          >
            Todavía no sigues ninguna propiedad. Pulsa &quot;Seguir&quot; (✓) en
            una tarjeta para añadirla a tu seguimiento.
          </p>
        </div>
      );
    }
    // A below-market (or source) filter is active but no assessment filter:
    // the feed is genuinely narrowed to nothing by a working filter, not
    // blocked on missing data. Filter-scoped message, keep the bar.
    if (minDiscount !== "" || source !== null) {
      return (
        <div>
          {filterBar}
          <p
            data-testid="no-candidates-for-filter"
            style={{
              marginTop: 16,
              fontSize: 13,
              color: "var(--fg-muted)",
              margin: 0,
            }}
          >
            No hay candidatos con estos criterios. Cambia o quita los filtros
            para ver el resto.
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
        <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>
          Este perfil no tiene candidatos.
        </p>
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
      {/* #425 cold-start: a brand-new profile (or one where >60% of the pool
          would tier as new) says so once instead of highlighting every card.
          Tracked (accept) properties are still surfaced normally — the
          suppression only turns off the fresh-first highlight/reorder. */}
      {noveltyColdStart && (
        <p
          data-testid="novelty-cold-start-note"
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
          Perfil nuevo: todo es reciente.
        </p>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
          marginTop: 16,
        }}
      >
        {items.map((c) => (
          <CandidateCard
            key={c.property_id}
            candidate={c}
            profileId={profileId}
            includeRejected={showRejected}
          />
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
