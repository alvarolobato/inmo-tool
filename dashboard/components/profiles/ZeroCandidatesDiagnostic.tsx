"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { ZeroCandidateDiagnosis } from "@/lib/profile-diagnostics-types";

const fmtEUR = (n: number) => `${n.toLocaleString("es-ES")} €`;
const fmtKm = (n: number) => `${n.toLocaleString("es-ES", { maximumFractionDigits: 1 })} km`;

function priceSizeMessage(d: Extract<ZeroCandidateDiagnosis, { kind: "price_size_empty" }>): string {
  const bounds: string[] = [];
  if (d.priceMin !== undefined || d.priceMax !== undefined) {
    if (d.priceMin !== undefined && d.priceMax !== undefined) {
      bounds.push(`entre ${fmtEUR(d.priceMin)} y ${fmtEUR(d.priceMax)}`);
    } else if (d.priceMin !== undefined) {
      bounds.push(`por encima de ${fmtEUR(d.priceMin)}`);
    } else if (d.priceMax !== undefined) {
      bounds.push(`por debajo de ${fmtEUR(d.priceMax)}`);
    }
  }
  if (d.sizeMin !== undefined || d.sizeMax !== undefined) {
    if (d.sizeMin !== undefined && d.sizeMax !== undefined) {
      bounds.push(`entre ${d.sizeMin} y ${d.sizeMax} m²`);
    } else if (d.sizeMin !== undefined) {
      bounds.push(`de más de ${d.sizeMin} m²`);
    } else if (d.sizeMax !== undefined) {
      bounds.push(`de menos de ${d.sizeMax} m²`);
    }
  }
  const boundText = bounds.length > 0 ? bounds.join(" y ") : "tu rango de precio/tamaño";
  return `${d.typeCount} inmuebles del tipo que buscas en la zona, pero ninguno ${boundText}.`;
}

/**
 * Shared zero-candidate diagnostic (issue #194) — one implementation used
 * from both the Perfiles list ("¿Por qué 0?" on-demand expansion, issue
 * #193) and CandidateList.tsx's empty state. Fetches
 * `GET /api/profiles/[id]/diagnostics` on mount — never part of a bulk
 * page-load query, only rendered for a profile a caller already knows is at
 * zero matched candidates.
 */
export function ZeroCandidatesDiagnostic({
  profileId,
  onRecalculated,
}: {
  profileId: number;
  onRecalculated?: () => void;
}) {
  const [diagnosis, setDiagnosis] = useState<ZeroCandidateDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const fetchDiagnosis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/diagnostics`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudo generar el diagnóstico.");
        return;
      }
      setDiagnosis(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el diagnóstico.");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    fetchDiagnosis();
  }, [fetchDiagnosis]);

  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      const res = await fetch(`/api/profiles/${profileId}/materialize`, { method: "POST" });
      if (!res.ok) {
        console.error("No se pudieron recalcular los candidatos:", res.status, await res.text().catch(() => ""));
      }
      await fetchDiagnosis();
      onRecalculated?.();
    } finally {
      setRecalculating(false);
    }
  };

  const recalcButtonStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 12px",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: recalculating ? "default" : "pointer",
    opacity: recalculating ? 0.6 : 1,
  };

  const wrapperStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-1)",
    fontSize: 12,
    color: "var(--fg-muted)",
  };

  if (loading) {
    return (
      <div data-testid="zero-diagnostic-loading" style={wrapperStyle}>
        Analizando por qué este perfil no tiene candidatos…
      </div>
    );
  }

  if (error) {
    return <ErrorDisplay error={error} className="mt-2" />;
  }

  if (diagnosis === null) return null;

  const RecalcButton = () => (
    <button
      type="button"
      onClick={handleRecalculate}
      disabled={recalculating}
      style={recalcButtonStyle}
      data-testid="zero-diagnostic-recalculate"
    >
      {recalculating ? "Recalculando…" : "Recalcular"}
    </button>
  );

  return (
    <div data-testid="zero-diagnostic" data-diagnosis-kind={diagnosis.kind} style={wrapperStyle}>
      {diagnosis.kind === "not_zero" && (
        <p style={{ margin: 0 }}>
          Este perfil ya tiene {diagnosis.matchedCount} candidatos — actualiza la página para verlos.
        </p>
      )}

      {diagnosis.kind === "never_materialized" && (
        <>
          <p style={{ margin: 0 }}>Este perfil aún no se ha calculado.</p>
          <RecalcButton />
        </>
      )}

      {diagnosis.kind === "geography_empty" && (
        <>
          {diagnosis.radiusKm === null ? (
            // Issue #659: "everywhere" scope — there is no center/radius to
            // report a distance against. Zero here means no property in the
            // whole pool has an active sale listing.
            <p style={{ margin: 0 }}>
              No hay ningún inmueble con anuncio de venta activo en toda la base de datos todavía.
            </p>
          ) : diagnosis.nearest === null ? (
            <p style={{ margin: 0 }}>
              No hay ningún inmueble con anuncio activo en toda la base de datos todavía.
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              El inmueble activo más cercano con datos está a {fmtKm(diagnosis.nearest.distanceKm)}; tu radio es de{" "}
              {diagnosis.radiusKm} km.
            </p>
          )}
          {/* Issue #217 / D-030: "no matches nearby" and "nobody has crawled
              here yet" used to render identically, and the second is the
              far more common cause for a brand-new profile in a new market.
              Shown above the global connector-recency line because it is
              area-specific and therefore strictly more informative. */}
          {/* PR #228 review, nit 7: this used to assert "ningún conector
              cubre esta zona … hace falta añadir cobertura", which the data
              does not support. A scope gets no row until its first attempt
              or budget-skip, and coverage circles deliberately under-report
              (see `_MUNICIPAL_COVERAGE_RADIUS_KM`), so a perfectly covered
              area lands here for a run or two — and the correct advice then
              is "wait one run", the opposite of what was shown. */}
          {diagnosis.areaCoverage?.kind === "never_crawled" && (
            <p style={{ margin: "4px 0 0" }}>
              No hay constancia de que se haya rastreado esta zona todavía. Si acabas de crear el perfil, puede
              aparecer tras una de las próximas ejecuciones; si sigue igual, probablemente falte cobertura para
              esta zona.
            </p>
          )}
          {diagnosis.areaCoverage?.kind === "awaiting_turn" && (
            <p style={{ margin: "4px 0 0" }}>
              Esta zona sí está cubierta ({diagnosis.areaCoverage.connectorNames.join(", ")}), pero todavía no le
              ha tocado el turno de rastreo. Debería rastrearse en una de las próximas ejecuciones.
            </p>
          )}
          {/* PR #228 review, finding 1: an attempted-but-never-successful
              scope must never render as "se rastreó el <fecha>" — nothing
              was ever retrieved, so "no hay resultados" says nothing about
              real inventory. */}
          {diagnosis.areaCoverage?.kind === "attempted_never_succeeded" && (
            <p style={{ margin: "4px 0 0" }}>
              Se ha intentado rastrear esta zona ({diagnosis.areaCoverage.connectorNames.join(", ")}), la última
              vez el {new Date(diagnosis.areaCoverage.lastAttemptedAt).toLocaleString("es-ES")}, pero ningún
              rastreo ha llegado a completarse. La falta de resultados no significa que no haya inmuebles.
            </p>
          )}
          {/* Issue #659: areaCoverage is null for an "everywhere" scope (no
              single area to report coverage for) — falls straight to the
              plain connector-recency line instead of a fabricated claim. */}
          <p style={{ margin: "4px 0 0", color: "var(--fg-subtle)" }}>
            {diagnosis.areaCoverage?.kind === "crawled"
              ? `Esta zona se rastreó por última vez el ${new Date(diagnosis.areaCoverage.lastCrawledAt).toLocaleString("es-ES")}.`
              : diagnosis.connectorLastRunFinishedAt === null
                ? "Ningún conector ha completado una ejecución todavía."
                : `Última ejecución de los conectores: ${new Date(diagnosis.connectorLastRunFinishedAt).toLocaleString("es-ES")}.`}
          </p>
        </>
      )}

      {diagnosis.kind === "type_empty" && (
        <p style={{ margin: 0 }}>
          Hay {diagnosis.geographyCount} inmuebles en la zona, pero ninguno del tipo que buscas (
          {diagnosis.propertyTypes.join(", ")}).
        </p>
      )}

      {diagnosis.kind === "price_size_empty" && <p style={{ margin: 0 }}>{priceSizeMessage(diagnosis)}</p>}

      {diagnosis.kind === "exclusion_empty" && (
        <p style={{ margin: 0 }}>
          {diagnosis.priceSizeCount} candidatos cumplen todo salvo {diagnosis.excludedBy.join(" y ")}.
        </p>
      )}

      {diagnosis.kind === "stale_materialization" && (
        <>
          <p style={{ margin: 0 }}>
            Los filtros sí encuentran candidatos, pero el perfil no se ha recalculado desde el último cambio.
          </p>
          <RecalcButton />
        </>
      )}
    </div>
  );
}
