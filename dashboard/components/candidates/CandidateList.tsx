"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  // #592: a failed page-2+ fetch (button OR sentinel-triggered) must be
  // visible and retryable — but must NOT blow away the already-loaded items
  // the way a page-1 (replace) failure does (that would turn one bad request
  // mid-scroll into a total wipeout). Kept separate from `error` above, which
  // stays page-1-only.
  const [loadMoreError, setLoadMoreError] = useState<
    ApiErrorResponse | string | null
  >(null);
  // #592: the in-flight guard for BOTH the "Cargar más" button and the mobile
  // IntersectionObserver sentinel. A ref, not `loadingMore` state — state
  // updates land a frame late, and the observer can re-fire inside that
  // window (the "double-firing" failure mode: two fetches in flight at once,
  // which can double-load a page or skip one under the keyset cursor).
  const loadingMoreRef = useRef(false);
  // Mirrors `loadMoreError` for the same reason: the sentinel effect's
  // closure is keyed off `loadMore`'s identity (which changes with `cursor`,
  // not with the error), so a plain state read there would be stale. This ref
  // stops the sentinel from silently re-triggering a fetch that just failed —
  // the failure must sit there until the user taps "Reintentar" here.
  const loadMoreErrorRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // #592 accessibility escape hatch (review #597): if `IntersectionObserver`
  // is unavailable, the mobile-only sentinel effect below is a silent no-op —
  // with the button ALSO hidden below 768px, that would leave no trigger at
  // all. Falls back to showing the button even on mobile in that case.
  const [observerUnsupported, setObserverUnsupported] = useState(false);
  // #592 accessibility escape hatch: an `aria-live` region (visually hidden,
  // `sr-only`) announces what the sentinel just did — a screen-reader user
  // scrolling past the sentinel gets no other signal that anything happened,
  // since the appended cards land below wherever their focus/reading
  // position already is.
  const [liveMessage, setLiveMessage] = useState("");
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
  // #467 (deep-load race fix): the feed must NOT fire its first page-1 fetch
  // until the filters have been seeded from the URL. Without this gate, mount
  // fires a fetch with the DEFAULT (empty) filters, then the URL-read effect
  // below corrects them and fires a second, narrower fetch — and on a contended
  // main thread (CI) the first, UNFILTERED response can land after the URL-read
  // effect is delayed, showing the whole pool under an active filter/chip. We
  // start `false` and flip to `true` in the same effect that reads the URL, so
  // the very first fetch already carries the deep-linked filters (one request,
  // no throwaway unfiltered round-trip). SSR-safe: nothing fetches on the server.
  const [filtersReady, setFiltersReady] = useState(false);
  const {
    q,
    source,
    occupancy,
    conditionSel,
    minDiscount,
    caveat,
    redflagType,
    beachProximity,
    heritageZone,
    isVpo,
    alerts,
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

  // #467: out-of-order guard for the page-1 (replace) fetch. The deep-load race
  // (mount's unfiltered fetch vs the URL-corrected one) is now prevented at the
  // source by `filtersReady` above — mount fires no fetch until the URL filters
  // are in. This guard still protects the OTHER page-1 race: rapid soft-nav
  // filter changes (e.g. toggling a chip twice quickly), where two replace
  // fetches are in flight and the slower stale one must not clobber the newer.
  // Each replace fetch bumps this seq; a response only applies if it is still
  // the latest replace request.
  const pageOneSeq = useRef(0);

  // Read the filters out of the URL once on mount (SSR-safe: starts at the
  // defaults, corrected on the client) — same window.location precedent as the
  // property-detail page (avoids the useSearchParams Suspense boundary).
  useEffect(() => {
    setFilters(parseCandidateFilters(window.location.search));
    // Both updates batch into one re-render, so the render that first turns the
    // fetch on already has the URL-seeded filters — the first page-1 request is
    // the correct (filtered) one, never a throwaway unfiltered fetch.
    setFiltersReady(true);
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
    isVpo !== "" ||
    // #466/#593: "Con alertas"/"Sin alertas" both read the same AI-assessment
    // axes (redflags + occupancy caveats), so an empty result under EITHER is
    // the "needs assessment" case too — fold it in so the empty state explains
    // that, not "broken".
    alerts !== "";

  const fetchPage = useCallback(
    async (afterCursor: string | null, replace: boolean) => {
      // #467: claim a sequence number for page-1 fetches so a stale (slower)
      // response can't overwrite a newer one — see pageOneSeq above.
      const seq = replace ? ++pageOneSeq.current : pageOneSeq.current;
      const url = new URL(
        `/api/profiles/${profileId}/candidates`,
        window.location.origin,
      );
      if (afterCursor !== null) url.searchParams.set("cursor", afterCursor);
      // #470 free-text search — narrows the feed to properties whose search doc
      // matches. Combines (AND) with every other filter and the cursor, exactly
      // like `source`; changing it resets to page 1 via fetchPage's identity.
      if (q !== "") url.searchParams.set("q", q);
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
      // #593 tri-state alerts filter → the API's hasAlerts=true/false. "" stays
      // off (param omitted); the negative is a distinct API value, never
      // inferred client-side from "not true" (that would be a second
      // definition of the predicate — see lib/candidates.ts).
      if (alerts === "1") url.searchParams.set("hasAlerts", "true");
      else if (alerts === "0") url.searchParams.set("hasAlerts", "false");
      // #379: opt in to rejected candidates. Omitted (default) keeps them hidden.
      if (showRejected) url.searchParams.set("includeRejected", "true");
      // #422: "En seguimiento" preset — restrict to tracked (accepted) properties.
      if (trackedOnly) url.searchParams.set("state", "accept");
      let res: Response;
      try {
        res = await fetch(url.toString().replace(window.location.origin, ""));
      } catch {
        // #592: a network failure (offline, DNS, aborted) must be as visible
        // and retryable as an HTTP error response — never an unhandled
        // rejection that leaves the sentinel/button silently stuck.
        if (replace && seq !== pageOneSeq.current) return;
        if (replace) {
          setError("Error al cargar los candidatos.");
        } else {
          setLoadMoreError("Error al cargar más candidatos.");
          loadMoreErrorRef.current = true;
          setLiveMessage("No se pudieron cargar más candidatos.");
        }
        return;
      }
      // #467: a newer page-1 fetch started while this one was in flight — drop
      // this stale response entirely (status, error, and body) so it can't
      // clobber the newer, correct result.
      if (replace && seq !== pageOneSeq.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const apiError = isApiErrorResponse(body)
          ? body
          : "Error al cargar los candidatos.";
        // #592: a page-1 (replace) failure keeps replacing the whole view with
        // the error, as before. A page-2+ (append) failure — whether from the
        // desktop button or the mobile sentinel — must leave the already-
        // loaded items on screen and surface a scoped, retryable error instead
        // of wiping the feed the user was already scrolled through.
        if (replace) {
          setError(apiError);
        } else {
          setLoadMoreError(apiError);
          loadMoreErrorRef.current = true;
          setLiveMessage("No se pudieron cargar más candidatos.");
        }
        return;
      }
      // #592 follow-up (review #597): a 200 response with a malformed body
      // (e.g. a proxy/edge case returning HTML with a 200 status) must be
      // treated exactly like an HTTP-level failure — NOT let `res.json()`
      // throw uncaught. `loadMore`'s try/finally always clears the in-flight
      // ref, but with no `catch` here an uncaught throw skipped setting
      // `loadMoreError`/its ref entirely: the sentinel would see "not
      // in-flight, no error" on the very next intersection and silently
      // retry forever, invisible to the user this PR otherwise promises a
      // visible, retryable failure to.
      let page: {
        items: CandidateRow[];
        nextCursor: string | null;
        coldStart?: boolean;
      };
      try {
        page = await res.json();
      } catch {
        if (replace && seq !== pageOneSeq.current) return;
        if (replace) {
          setError("Respuesta inválida del servidor al cargar los candidatos.");
        } else {
          setLoadMoreError("Respuesta inválida del servidor al cargar más candidatos.");
          loadMoreErrorRef.current = true;
          setLiveMessage("No se pudieron cargar más candidatos.");
        }
        return;
      }
      if (!replace) {
        setLoadMoreError(null);
        loadMoreErrorRef.current = false;
        // #592 accessibility escape hatch: announce what just landed (and
        // whether that was the last page) for a screen-reader user who never
        // "sees" the sentinel or the appended cards scroll into view.
        setLiveMessage(
          page.nextCursor === null
            ? `${page.items.length} candidatos más cargados. No hay más candidatos.`
            : `${page.items.length} candidatos más cargados.`,
        );
      }
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
      q,
      source,
      occupancy,
      conditionSel,
      minDiscount,
      caveat,
      redflagType,
      beachProximity,
      heritageZone,
      isVpo,
      alerts,
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

  // Re-runs on profile OR filter change (fetchPage's identity depends on both) —
  // resetting the feed to page 1 whenever the filter changes. Gated on
  // `filtersReady` so the FIRST run happens only after the URL filters are
  // seeded (see the filtersReady note above): on the initial mount this effect
  // no-ops until the URL-read effect flips the flag, at which point fetchPage
  // already carries the deep-linked filters — a single, correct page-1 request.
  useEffect(() => {
    if (!filtersReady) return;
    setItems([]);
    setCursor(null);
    setError(null);
    // A filter/profile change restarts pagination from page 1 — any pending
    // load-more failure from the PREVIOUS filter's cursor no longer applies.
    setLoadMoreError(null);
    loadMoreErrorRef.current = false;
    setLoading(true);
    fetchPage(null, true).finally(() => setLoading(false));
  }, [fetchPage, filtersReady]);

  // #592: shared by the desktop "Cargar más" button and the mobile
  // IntersectionObserver sentinel below. `loadingMoreRef` (checked AND set
  // synchronously, before the first `await`) is the double-fire guard a
  // re-intersecting sentinel needs — `loadingMore` state alone would still
  // read false for one render/microtask after a fetch starts, and the
  // observer can re-fire inside that window.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || cursor === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      await fetchPage(cursor, false);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [cursor, fetchPage]);

  // #592 accessibility escape hatch (review #597): detected independently of
  // whether the sentinel is even in the DOM (it may not be yet — cursor
  // starts null before the first page-1 response lands), so the fallback is
  // ready before the render below has to decide whether to show the button.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setObserverUnsupported(true);
    }
  }, []);

  // #592: mobile-only infinite scroll. The sentinel div below is rendered
  // with `md:hidden` (visible only under the 768px breakpoint, D-120) so on
  // desktop it either isn't in the DOM (cursor === null) or has no layout box
  // and never intersects — the explicit "Cargar más" button stays the only
  // trigger there, unchanged. `rootMargin` starts the fetch a bit before the
  // sentinel actually reaches the viewport so the next page is usually ready
  // by the time the user scrolls that far. Not rendered at all when
  // `observerUnsupported` — the button (shown on every viewport in that
  // case) is the trigger instead.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !loadingMoreRef.current &&
          !loadMoreErrorRef.current
        ) {
          void loadMore();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

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
    // #470: a free-text search matched nothing. More specific than the generic
    // filter-narrowed message below and than source/below-market — say so and
    // offer a one-click way out. Placed after the assessment/tracked branches
    // (per plan) so those more structural causes take precedence.
    if (q !== "") {
      return (
        <div>
          {filterBar}
          <p
            data-testid="no-candidates-for-search"
            style={{
              marginTop: 16,
              fontSize: 13,
              color: "var(--fg-muted)",
              margin: 0,
            }}
          >
            Sin resultados para «{q}». Prueba con otros términos o quita la
            búsqueda.{" "}
            <button
              type="button"
              data-testid="clear-search-empty-state"
              onClick={() => updateFilters({ ...filters, q: "" })}
              style={{
                padding: 0,
                border: "none",
                background: "transparent",
                color: "var(--accent)",
                cursor: "pointer",
                fontSize: 13,
                textDecoration: "underline",
              }}
            >
              Quitar búsqueda
            </button>
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
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 14,
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

      {/* #592 accessibility escape hatch: an aria-live region announcing what
          the sentinel just did (candidates appended, load failed, or the end
          reached) — visually hidden (`sr-only`) but read out by a screen
          reader regardless of where the user's focus/reading position is,
          since the appended cards land silently below it otherwise. Rendered
          unconditionally (not gated on `cursor`) so it survives every state
          transition, including reaching the end. */}
      <div aria-live="polite" role="status" className="sr-only">
        {liveMessage}
      </div>

      {cursor !== null && (
        <>
          {/* Desktop: the explicit "Cargar más" control (#592 keeps it here —
              a button is genuinely better with a mouse). Also the escape
              hatch when `IntersectionObserver` is unsupported — shown on
              EVERY viewport then, since the mobile sentinel is a no-op
              without it. `className` is the ONLY display toggle in either
              case (D-120: no inline `display` alongside a responsive display
              class); every other style stays inline as elsewhere in this
              component. */}
          <button
            data-testid="load-more-button"
            onClick={loadMore}
            disabled={loadingMore}
            className={observerUnsupported ? "inline-block" : "hidden md:inline-block"}
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

          {/* Mobile: an invisible sentinel the IntersectionObserver (above)
              watches — scrolling it into view loads the next page with no
              tap. `md:hidden` means it either isn't rendered (cursor is null)
              or has no layout box on desktop and never intersects there, so
              the button above stays the only trigger on desktop (unchanged
              behaviour). Not rendered at all when the API is unsupported —
              the always-visible button above is the only trigger then, so
              there is no dead target left in the DOM. */}
          {!observerUnsupported && (
            <div
              ref={sentinelRef}
              data-testid="infinite-scroll-sentinel"
              aria-hidden="true"
              className="md:hidden"
              style={{ marginTop: 16, height: 1 }}
            />
          )}
          {loadingMore && (
            <p
              data-testid="infinite-scroll-loading"
              className="md:hidden"
              style={{ marginTop: 8, fontSize: 13, color: "var(--fg-muted)" }}
            >
              Cargando más candidatos…
            </p>
          )}
        </>
      )}

      {/* #592: a failed page-2+ fetch (button OR sentinel) stays visible next
          to where the next page would have appeared, with a "Reintentar" that
          re-runs the SAME fetch (loadMore) — never a silent stall, and never
          the whole-feed wipeout a page-1 failure produces (`error` above). */}
      {loadMoreError && (
        <ErrorDisplay
          error={loadMoreError}
          title="No se pudieron cargar más candidatos"
          onRetry={loadMore}
          className="mt-4"
        />
      )}

      {/* #592: an honest end state — mobile's auto-loading feed must say when
          it's done rather than silently stopping (which reads as broken).
          Desktop already states this unambiguously by the button disappearing,
          so this note is mobile-only (md:hidden). */}
      {cursor === null && !loadMoreError && items.length > 0 && (
        <p
          data-testid="candidates-end-of-list"
          className="md:hidden"
          style={{
            marginTop: 16,
            fontSize: 13,
            color: "var(--fg-muted)",
            textAlign: "center",
          }}
        >
          No hay más candidatos.
        </p>
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
