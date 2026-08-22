"use client";

/**
 * Cohort re-capture panel (issue #677) — select a set of listings by an
 * explicit predicate, see what re-capturing them costs, then confirm.
 *
 * Three rules shape this UI:
 *
 *  1. **Query-driven, not per-row.** The realistic cohort is thousands of rows;
 *     a multi-select checkbox list is unusable on a phone and meaningless at
 *     that scale. The operator picks a portal and a named predicate instead.
 *     The predicate list is a closed enum shared with the server
 *     (`lib/recapture.ts`) — this is not a SQL console.
 *
 *  2. **Count before acting.** "Calcular" is read-only. The confirm button
 *     stays disabled until a preview has come back, and it carries the count.
 *     Re-editing any field invalidates the preview, so the number on the button
 *     is always the number that was measured.
 *
 *  3. **The cost is stated, not implied.** A few thousand pages is an
 *     overnight-scale commitment of real browser time, and with HTML retention
 *     on it is hundreds of megabytes into a shared database. Both are shown
 *     before the confirm arms.
 *
 * Mobile-first (D-120/D-121/D-124): controls stack below 768px via the
 * `.recapture-*` classes in globals.css — no inline `display`, no `flexWrap`
 * with basis-0 children, tap targets ≥44px.
 */

import { useCallback, useMemo, useState } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse, type ApiErrorResponse } from "@/lib/errors";
import {
  formatBytes,
  formatDuration,
  RECAPTURE_PREDICATES,
  RECAPTURE_PREDICATE_LABEL,
  type RecaptureCohortPreview,
  type RecapturePredicate,
} from "@/lib/recapture";
import { CAPTURE_PORTAL_NAMES } from "@/lib/worklist";

export function RecapturePanel({
  portal: initialPortal,
  onRequeued,
}: {
  /** Portal the page is deep-linked to, if any. */
  portal: string | null;
  /** Called after a successful requeue so the ledger reloads. */
  onRequeued: () => void | Promise<void>;
}) {
  const [portal, setPortal] = useState<string>(
    initialPortal &&
      (CAPTURE_PORTAL_NAMES as readonly string[]).includes(initialPortal)
      ? initialPortal
      : CAPTURE_PORTAL_NAMES[0],
  );
  const [predicate, setPredicate] = useState<RecapturePredicate>("few_photos");
  const [threshold, setThreshold] = useState<string>(
    String(RECAPTURE_PREDICATE_LABEL.few_photos.defaultThreshold ?? ""),
  );
  const [onlyLiveCandidates, setOnlyLiveCandidates] = useState(true);
  const [reason, setReason] = useState("");

  const [preview, setPreview] = useState<RecaptureCohortPreview | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const spec = RECAPTURE_PREDICATE_LABEL[predicate];

  /**
   * Any edit to the cohort invalidates the measured preview — otherwise the
   * confirm button could carry a count that belongs to a different query.
   */
  const invalidate = useCallback(() => {
    setPreview(null);
    setArming(false);
    setResult(null);
  }, []);

  const handleCalculate = useCallback(async () => {
    setCalculating(true);
    setError(null);
    setResult(null);
    setArming(false);
    try {
      const params = new URLSearchParams({
        portal,
        predicate,
        onlyLiveCandidates: String(onlyLiveCandidates),
      });
      if (spec.unit !== null) params.set("threshold", threshold);
      const res = await fetch(`/api/etl/worklist/recapture?${params}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          isApiErrorResponse(body) ? body : "No se pudo calcular el conjunto",
        );
        return;
      }
      setPreview(body as RecaptureCohortPreview);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo calcular el conjunto",
      );
    } finally {
      setCalculating(false);
    }
  }, [portal, predicate, threshold, onlyLiveCandidates, spec.unit]);

  const handleConfirm = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/etl/worklist/recapture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portal,
          predicate,
          threshold: spec.unit !== null ? Number(threshold) : null,
          onlyLiveCandidates,
          reason,
          expectedCount: preview.rowCount,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          isApiErrorResponse(body)
            ? body
            : "No se pudo marcar el conjunto para recaptura",
        );
        setPreview(null);
        return;
      }
      setResult(
        `${body.requeued} fila(s) marcadas para recaptura. Para empezar: abre una página de búsqueda del portal, pulsa el icono de la extensión y dale a "Capturar todas" — drenará la cola por orden de valor.`,
      );
      setPreview(null);
      setArming(false);
      setReason("");
      await onRequeued();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo marcar el conjunto para recaptura",
      );
    } finally {
      setBusy(false);
    }
  }, [
    preview,
    portal,
    predicate,
    threshold,
    onlyLiveCandidates,
    reason,
    spec.unit,
    onRequeued,
  ]);

  const canConfirm = useMemo(
    () => preview !== null && preview.rowCount > 0 && reason.trim().length > 0,
    [preview, reason],
  );

  return (
    <section
      data-testid="recapture-panel"
      className="recapture-panel"
      style={{
        marginTop: 24,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-1)",
      }}
    >
      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--fg)",
          margin: 0,
        }}
      >
        Marcar un conjunto para recaptura
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "var(--fg-muted)",
          marginTop: 6,
          marginBottom: 0,
        }}
      >
        Cuando un fallo del parser deja anuncios con datos malos, esto devuelve
        sus filas a <strong>pendiente</strong> para que la extensión los vuelva
        a capturar. No crea una cola nueva: reutiliza la que ya drena la captura
        por lotes de la extensión. Las filas recapturadas quedan marcadas como
        tales, así que siguen distinguiéndose de las que nunca se capturaron.
      </p>

      {/* ── Cohort selection ─────────────────────────────────────────────── */}
      <div className="recapture-fields">
        <label className="recapture-field">
          <span className="recapture-label">Portal</span>
          <select
            data-testid="recapture-portal"
            className="recapture-input"
            value={portal}
            onChange={(e) => {
              setPortal(e.target.value);
              invalidate();
            }}
          >
            {CAPTURE_PORTAL_NAMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="recapture-field">
          <span className="recapture-label">Criterio</span>
          <select
            data-testid="recapture-predicate"
            className="recapture-input"
            value={predicate}
            onChange={(e) => {
              const next = e.target.value as RecapturePredicate;
              setPredicate(next);
              const d = RECAPTURE_PREDICATE_LABEL[next].defaultThreshold;
              setThreshold(d === null ? "" : String(d));
              invalidate();
            }}
          >
            {RECAPTURE_PREDICATES.map((p) => (
              <option key={p} value={p}>
                {RECAPTURE_PREDICATE_LABEL[p].label}
              </option>
            ))}
          </select>
        </label>

        {spec.unit !== null && (
          <label className="recapture-field recapture-field-narrow">
            <span className="recapture-label">N ({spec.unit})</span>
            <input
              data-testid="recapture-threshold"
              className="recapture-input"
              type="number"
              inputMode="numeric"
              min={1}
              value={threshold}
              onChange={(e) => {
                setThreshold(e.target.value);
                invalidate();
              }}
            />
          </label>
        )}
      </div>

      <label className="recapture-check">
        <input
          data-testid="recapture-only-candidates"
          type="checkbox"
          checked={onlyLiveCandidates}
          onChange={(e) => {
            setOnlyLiveCandidates(e.target.checked);
            invalidate();
          }}
        />
        <span>
          Solo candidatos vivos — anuncios cuya vivienda encaja en algún perfil
          activo y no está descartada. Recapturar un anuncio que nadie va a
          mirar es navegación desperdiciada.
        </span>
      </label>

      <div className="recapture-actions">
        <button
          data-testid="recapture-calculate"
          className="recapture-btn"
          onClick={handleCalculate}
          disabled={calculating || busy}
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-2, var(--bg-1))",
            color: "var(--fg)",
          }}
        >
          {calculating ? "Calculando…" : "Calcular"}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {result && (
        <p
          data-testid="recapture-result"
          style={{
            fontSize: 13,
            color: "#16a34a",
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          {result}
        </p>
      )}

      {/* ── The measured cost, before anything is written ─────────────────── */}
      {preview && (
        <div
          data-testid="recapture-estimate"
          className="recapture-estimate"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-0, transparent)",
          }}
        >
          {preview.rowCount === 0 ? (
            <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>
              Ningún anuncio capturado encaja con este criterio. Solo se pueden
              recapturar filas en estado <strong>Capturada</strong> — las
              omitidas, fallidas y obsoletas se dejan en paz a propósito.
            </p>
          ) : (
            <>
              <p
                data-testid="recapture-count"
                style={{
                  fontSize: 14,
                  color: "var(--fg)",
                  margin: 0,
                  fontWeight: 600,
                }}
              >
                {preview.rowCount} fila(s) volverían a pendiente
                {preview.alreadyRequeuedCount > 0 && (
                  <span style={{ fontWeight: 400, color: "var(--fg-muted)" }}>
                    {" "}
                    ({preview.alreadyRequeuedCount} ya recapturada(s) antes)
                  </span>
                )}
              </p>
              <ul className="recapture-cost-list">
                <li>
                  <strong>{formatDuration(preview.estimate.seconds)}</strong> de
                  navegación continua con el navegador abierto, al ritmo con
                  jitter que la extensión trae por defecto (si has cambiado el
                  ritmo en sus ajustes, esta cifra no lo ve) (~
                  {preview.estimate.secondsPerListing} s por anuncio de media —
                  el ritmo se va frenando solo a partir de las 150 páginas).
                </li>
                {preview.estimate.htmlRetentionOn ? (
                  <li data-testid="recapture-storage-warning">
                    <strong style={{ color: "#dc2626" }}>
                      {formatBytes(preview.estimate.storedHtmlBytes)}
                    </strong>{" "}
                    en la base de datos (
                    {formatBytes(preview.estimate.rawHtmlBytes)} de HTML sin
                    comprimir): este portal está reteniendo el HTML de cada
                    captura. Considera apagar la retención antes de una pasada
                    masiva.
                  </li>
                ) : (
                  <li>
                    Sin coste de almacenamiento: este portal no está reteniendo
                    el HTML de las capturas.
                  </li>
                )}
                <li style={{ color: "var(--fg-muted)" }}>
                  Se capturarán primero los anuncios de más valor (mejor
                  puntuación de perfil, y a igualdad de puntuación los que menos
                  fotos tienen).
                </li>
                {/* The value ordering only survives the MANUAL batch path.
                    Auto mode drains through selectNextPendingUrls, which ranks
                    by portal due-rank then createdAt and ignores requeue_rank
                    entirely (lib/db/worklist.ts) — so with Auto on, the whole
                    ordering this panel just promised is moot. Say so here
                    rather than changing auto-capture's ordering. */}
                <li data-testid="recapture-auto-warning">
                  <strong>
                    Apaga el modo Auto de la extensión antes de empezar.
                  </strong>{" "}
                  El modo Auto drena la cola por antigüedad, no por valor: si
                  está encendido, este orden no se respeta.
                </li>
                {preview.captureProcessingEnabled === false && (
                  <li data-testid="recapture-capture-disabled">
                    <strong style={{ color: "#dc2626" }}>
                      La captura de {portal} está desactivada.
                    </strong>{" "}
                    El ETL no procesaría nada de lo que captures: las filas se
                    quedarían pendientes para siempre. Actívala en Fuentes antes
                    de recapturar.
                  </li>
                )}
              </ul>

              <label className="recapture-field" style={{ marginTop: 12 }}>
                <span className="recapture-label">
                  Motivo (queda registrado en cada fila)
                </span>
                <input
                  data-testid="recapture-reason"
                  className="recapture-input"
                  type="text"
                  maxLength={500}
                  placeholder="p. ej. galería truncada a 3 fotos (#625)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>

              {/* Two-step armed confirm, matching the dedup reject pattern
                  (D-133/D-135): the first tap only arms, and the warning names
                  the consequence in real-world units before the second tap. */}
              <div className="recapture-actions">
                {arming && (
                  <span
                    data-testid="recapture-confirm-warning"
                    style={{ fontSize: 12, color: "var(--fg-muted)" }}
                  >
                    Se marcarán {preview.rowCount} anuncio(s) de {portal} para
                    volver a capturarlos —{" "}
                    {formatDuration(preview.estimate.seconds)} de navegación.
                  </span>
                )}
                {arming && (
                  <button
                    data-testid="recapture-confirm-cancel"
                    className="recapture-btn"
                    disabled={busy}
                    onClick={() => setArming(false)}
                    style={{
                      border: "1px solid var(--border)",
                      background: "var(--bg-1)",
                      color: "var(--fg)",
                    }}
                  >
                    Cancelar
                  </button>
                )}
                <button
                  data-testid="recapture-confirm"
                  className="recapture-btn"
                  disabled={!canConfirm || busy}
                  title={
                    reason.trim().length === 0
                      ? "Escribe un motivo antes de confirmar"
                      : undefined
                  }
                  onClick={() => (arming ? handleConfirm() : setArming(true))}
                  style={{
                    border: arming
                      ? "1px solid var(--danger, #ff9b9b)"
                      : "1px solid var(--border)",
                    background: "var(--bg-1)",
                    color: arming ? "var(--danger, #ff9b9b)" : "var(--fg)",
                    opacity: canConfirm ? 1 : 0.6,
                  }}
                >
                  {busy
                    ? "Marcando…"
                    : arming
                      ? `Sí, marcar ${preview.rowCount}`
                      : `Marcar ${preview.rowCount} para recaptura`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
