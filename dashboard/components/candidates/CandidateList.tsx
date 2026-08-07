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

  // #310 hard filters (D-059). All optional, all combine with each other and
  // with the source filter/pagination. `occupancy`/`conditionSel` gate on AI
  // assessment data (empty until #316), so they legitimately narrow the feed to
  // nothing until that data flows — the empty state below says so explicitly
  // instead of implying the feed is broken. `minDiscount` is a percent computed
  // from price and works today. `conditionSel` is a composite token ("" |
  // "a_reformar" | "a_reformar:leve" | "a_reformar:integral" | "reformado" |
  // "obra_nueva") that maps to the API's separate condition/renovation params.
  const [occupancy, setOccupancy] = useState<string>("");
  const [conditionSel, setConditionSel] = useState<string>("");
  const [minDiscount, setMinDiscount] = useState<string>("");
  // #386 (Fase 1 of #385): expose the already-derived occupancy caveats
  // (`venta_deuda` etc.) and redflags problem types (`unfinished_construction`
  // etc.) as hard filters. Both read AI-assessment data (empty until #316), so
  // they narrow the feed to nothing until that data flows — folded into
  // `assessmentFilterActive` below so the empty state says "needs assessment"
  // rather than implying the feed is broken.
  const [caveat, setCaveat] = useState<string>("");
  const [redflagType, setRedflagType] = useState<string>("");
  // #392 (Fase 4 of #385): the owner's headline ask — beach proximity as a
  // MINIMUM-grade hard filter (frontline = only primera línea; sea_view =
  // frontline or vistas al mar; near_beach = any beach signal) plus a
  // casco-histórico toggle. Both read the `location` AI-assessment axis (empty
  // until the LLM populates it), so they're folded into `assessmentFilterActive`
  // below — an empty feed says "needs assessment", not "broken".
  const [beachProximity, setBeachProximity] = useState<string>("");
  const [heritageZone, setHeritageZone] = useState(false);
  // #398 (Fase 5 of #385): VPO / vivienda protegida as a BIDIRECTIONAL hard
  // filter — "" = off, "true" = only VPO, "false" = exclude VPO. Reads the
  // `opportunity` assessment axis (empty until the LLM populates it), so it's
  // folded into `assessmentFilterActive` for the "needs assessment" empty state.
  const [isVpo, setIsVpo] = useState<string>("");
  // #379: show-rejected toggle. Default OFF — the feed hides rejected
  // candidates (today's behaviour), so a reject only "removes" a card on the
  // next fetch. ON re-fetches with `includeRejected=true`, surfacing rejected
  // candidates (rendered marked, still un-rejectable). Wired into fetchPage's
  // identity below, so flipping it resets the feed to page 1.
  const [showRejected, setShowRejected] = useState(false);

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
      const url = new URL(`/api/profiles/${profileId}/candidates`, window.location.origin);
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
      if (beachProximity !== "") url.searchParams.set("beachProximity", beachProximity);
      if (heritageZone) url.searchParams.set("heritageZone", "true");
      // #398 VPO (bidirectional): "true" only VPO, "false" exclude VPO.
      if (isVpo !== "") url.searchParams.set("isVpo", isVpo);
      // #379: opt in to rejected candidates. Omitted (default) keeps them hidden.
      if (showRejected) url.searchParams.set("includeRejected", "true");
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

  // The filter bar must render in EVERY state (loading/error/empty/populated),
  // not just alongside a full grid — otherwise narrowing to a filter with zero
  // candidates would early-return the empty state and hide the very controls
  // the user needs to clear the filter. Rendered once here, above whatever body
  // the state below produces. The #310 distress/condition/discount filters
  // always render (they don't depend on live source data); the source (#265)
  // select is hidden only when the profile has no sources at all.
  const selectStyle = {
    padding: "5px 8px",
    fontSize: 13,
    color: "var(--fg)",
    background: "var(--bg-1)",
    border: "1px solid var(--border)",
    borderRadius: 6,
  } as const;
  const filterBar = (
    <div
      data-testid="candidate-filter-bar"
      style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, flexWrap: "wrap" }}
    >
      {availableSources.length > 0 && (
        <>
          <label htmlFor="candidate-source-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            Fuente
          </label>
          <select
            id="candidate-source-filter"
            data-testid="source-filter"
            value={source ?? ""}
            onChange={(e) => setSource(e.target.value === "" ? null : e.target.value)}
            style={{ ...selectStyle, textTransform: "capitalize" }}
          >
            <option value="">Todas las fuentes</option>
            {availableSources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </>
      )}

      {/* #310: occupancy (occupied vs free). Needs assessment data (#316). */}
      <label htmlFor="candidate-occupancy-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Ocupación
      </label>
      <select
        id="candidate-occupancy-filter"
        data-testid="occupancy-filter"
        value={occupancy}
        onChange={(e) => setOccupancy(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="occupied">Ocupado</option>
        <option value="free">Libre</option>
      </select>

      {/* #310: condition + renovation severity (#313), combined. Needs assessment data. */}
      <label htmlFor="candidate-condition-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Estado
      </label>
      <select
        id="candidate-condition-filter"
        data-testid="condition-filter"
        value={conditionSel}
        onChange={(e) => setConditionSel(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="a_reformar">A reformar</option>
        <option value="a_reformar:leve">A reformar (leve)</option>
        <option value="a_reformar:integral">A reformar (integral)</option>
        <option value="reformado">Reformado</option>
        <option value="obra_nueva">Obra nueva</option>
      </select>

      {/* #310: below-market discount threshold. Works today (computed from price). */}
      <label htmlFor="candidate-discount-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Bajo mercado
      </label>
      <select
        id="candidate-discount-filter"
        data-testid="discount-filter"
        value={minDiscount}
        onChange={(e) => setMinDiscount(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="10">≥ 10%</option>
        <option value="15">≥ 15%</option>
        <option value="20">≥ 20%</option>
        <option value="25">≥ 25%</option>
      </select>

      {/* #386: occupancy caveat (venta_deuda etc.). Needs assessment data (#316). */}
      <label htmlFor="candidate-caveat-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Situación jurídica
      </label>
      <select
        id="candidate-caveat-filter"
        data-testid="caveat-filter"
        value={caveat}
        onChange={(e) => setCaveat(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="venta_deuda">Venta de deuda</option>
        <option value="nuda_propiedad">Nuda propiedad</option>
        <option value="usufructo">Usufructo</option>
        <option value="proindiviso">Proindiviso</option>
        <option value="derecho_superficie">Derecho de superficie</option>
      </select>

      {/* #386: redflags problem type (obra sin terminar / embargo / …). Needs assessment data. */}
      <label htmlFor="candidate-redflag-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Alerta
      </label>
      <select
        id="candidate-redflag-filter"
        data-testid="redflag-filter"
        value={redflagType}
        onChange={(e) => setRedflagType(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="unfinished_construction">Obra inacabada</option>
        <option value="embargo">Embargo</option>
        <option value="subasta_judicial">Subasta judicial</option>
        <option value="litigio">Litigio</option>
        <option value="construccion_ilegal">Construcción ilegal</option>
        <option value="herencia_yacente">Herencia yacente</option>
        <option value="deuda_comunidad">Deuda comunidad</option>
        <option value="sin_financiacion_hipotecaria">Sin financiación hipotecaria</option>
        <option value="cambio_uso_pendiente">Cambio de uso pendiente</option>
        <option value="structural_damage">Daño estructural</option>
      </select>

      {/* #392: beach proximity as a MINIMUM-grade filter (owner's headline ask).
          frontline = only primera línea; sea_view = frontline or vistas al mar;
          near_beach = any beach signal. Needs the `location` assessment axis. */}
      <label htmlFor="candidate-beach-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Playa
      </label>
      <select
        id="candidate-beach-filter"
        data-testid="beach-filter"
        value={beachProximity}
        onChange={(e) => setBeachProximity(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="frontline">Primera línea</option>
        <option value="sea_view">Vistas al mar o mejor</option>
        <option value="near_beach">Cerca de playa o mejor</option>
      </select>

      {/* #392: casco-histórico toggle. On → only heritage-zone candidates. Needs
          the `location` assessment axis. */}
      <label
        htmlFor="candidate-heritage-toggle"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-muted)", cursor: "pointer" }}
      >
        <input
          id="candidate-heritage-toggle"
          data-testid="heritage-filter"
          type="checkbox"
          checked={heritageZone}
          onChange={(e) => setHeritageZone(e.target.checked)}
          style={{ cursor: "pointer" }}
        />
        Casco histórico
      </label>

      {/* #398: VPO / vivienda protegida as a BIDIRECTIONAL hard filter — only
          VPO or exclude VPO. Needs the `opportunity` assessment axis. */}
      <label htmlFor="candidate-vpo-filter" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        VPO
      </label>
      <select
        id="candidate-vpo-filter"
        data-testid="vpo-filter"
        value={isVpo}
        onChange={(e) => setIsVpo(e.target.value)}
        style={selectStyle}
      >
        <option value="">Cualquiera</option>
        <option value="true">Solo VPO</option>
        <option value="false">Sin VPO</option>
      </select>

      {/* #379: show/hide rejected candidates. Default off (rejected hidden).
          Turning it on re-fetches with includeRejected=true so the user can
          review and un-reject past rejections. */}
      <label
        htmlFor="show-rejected-toggle"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-muted)", cursor: "pointer" }}
      >
        <input
          id="show-rejected-toggle"
          data-testid="show-rejected-toggle"
          type="checkbox"
          checked={showRejected}
          onChange={(e) => setShowRejected(e.target.checked)}
          style={{ cursor: "pointer" }}
        />
        Mostrar descartadas
      </label>
    </div>
  );

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
            style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)", margin: 0 }}
          >
            No hay candidatos con estos criterios. Los filtros de ocupación y estado usan datos de
            evaluación de la IA, que aún no están disponibles para estas propiedades. Quita el filtro
            para ver el resto.
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
            style={{ marginTop: 16, fontSize: 13, color: "var(--fg-muted)", margin: 0 }}
          >
            No hay candidatos con estos criterios. Cambia o quita los filtros para ver el resto.
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
