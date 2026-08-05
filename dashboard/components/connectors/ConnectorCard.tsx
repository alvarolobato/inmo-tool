"use client";

import { useState } from "react";
import { LocationPicker, type LocationPickerValue } from "@/components/profiles/LocationPicker";
import { RunNowButton } from "@/components/connectors/RunNowButton";
import type {
  ConnectorConfigPatch,
  ConnectorFreshnessState,
  ConnectorView,
  GeographyOverride,
} from "@/lib/connectors-schema";

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-1)",
  marginBottom: 8,
  overflow: "hidden",
};

// The always-visible summary row. A single narrow band per connector so the
// list is skimmable — the full configuration lives behind the chevron (issue #264).
const summaryRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
};

// The chevron toggle: transparent, borderless, wraps the identity block so the
// whole left side of the row is one big expand target (matches LogBlock).
const expandButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
};

const detailStyle: React.CSSProperties = {
  padding: "4px 16px 16px",
  borderTop: "1px solid var(--border)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-muted)",
  marginBottom: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-2)",
  color: "var(--fg)",
  fontSize: 13,
  cursor: "pointer",
};

function Pill({ text, tone }: { text: string; tone: "on" | "off" | "muted" }) {
  const colors =
    tone === "on"
      ? { bg: "rgba(34,197,94,0.15)", fg: "rgb(34,197,94)" }
      : tone === "off"
        ? { bg: "rgba(239,68,68,0.15)", fg: "rgb(239,68,68)" }
        : { bg: "var(--bg-2)", fg: "var(--fg-muted)" };
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
      }}
    >
      {text}
    </span>
  );
}

/**
 * Explains, in plain language, what this connector will actually ingest on
 * its next run — the visibility gap that made ingestion feel unpredictable
 * (issue #96: an operator had no way to see what a profile's geography
 * resolved to without reading ETL logs).
 */
function ScopeSummary({ connector }: { connector: ConnectorView }) {
  const muted: React.CSSProperties = { fontSize: 12, color: "var(--fg-muted)", margin: "2px 0 0" };

  if (connector.scopeSource === "capture-only") {
    return (
      <p style={muted} data-testid="scope-summary">
        Solo captura: este conector no realiza búsquedas propias. Los anuncios
        entran mediante la extensión de navegador, así que no hay ámbito ni
        filtros que configurar.
      </p>
    );
  }

  if (connector.scopeSource === "override") {
    const o = connector.geography_override!;
    return (
      <p style={muted} data-testid="scope-summary">
        Ámbito explícito: {o.center[0].toFixed(4)}, {o.center[1].toFixed(4)} · radio{" "}
        {o.radius_km} km. Ignora los perfiles de búsqueda activos.
      </p>
    );
  }

  if (connector.scopeSource === "none") {
    return (
      <p style={muted} data-testid="scope-summary">
        Sin ámbito: no hay ningún ámbito explícito ni perfiles de búsqueda
        activos, así que este conector no descargará nada.
      </p>
    );
  }

  return (
    <div data-testid="scope-summary">
      <p style={muted}>
        Derivado de {connector.derivedFrom.length}{" "}
        {connector.derivedFrom.length === 1 ? "perfil activo" : "perfiles activos"}:
      </p>
      <ul style={{ ...muted, paddingLeft: 18, listStyle: "disc" }}>
        {connector.derivedFrom.map((d) => (
          <li key={d.profile_id}>
            {d.profile_name} — {d.center[0].toFixed(4)}, {d.center[1].toFixed(4)} · radio{" "}
            {d.radius_km} km
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One-line last-run summary for the collapsed row: status, how much it pulled,
 * and when. The full breakdown (errors, error message) stays in the expanded
 * detail — this is the at-a-glance version (issue #264).
 */
function lastRunSummary(connector: ConnectorView): string {
  if (!connector.lastRun) return "Sin ejecuciones";
  const r = connector.lastRun;
  const when = r.started_at ? new Date(r.started_at).toLocaleString("es-ES") : null;
  const parts = [r.status, `${r.fetched_count} descargados`];
  if (when) parts.push(when);
  return parts.join(" · ");
}

/** Preset cadence options for the "frescura deseada" control (issue #295). */
const FRESHNESS_PRESETS: { label: string; hours: number | null }[] = [
  { label: "usar valor por defecto", hours: null },
  { label: "1 hora", hours: 1 },
  { label: "6 horas", hours: 6 },
  { label: "24 horas", hours: 24 },
  { label: "3 días", hours: 72 },
  { label: "7 días", hours: 168 },
];

function ageLabel(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `hace ${mins}m` : `hace ${Math.round(mins / 60)}h`;
}

/** The human phrasing of one connector's freshness cadence state (issue #295). */
function freshnessStateText(f: ConnectorFreshnessState): string {
  switch (f.kind) {
    case "fresh":
      return `fresco (${ageLabel(f.lastFreshAt) ?? "recién refrescado"})`;
    case "refreshing":
      return `refrescando… (${f.coveredScopeCount ?? 0}/${f.targetScopeCount ?? 0} ámbitos)`;
    case "stuck":
      return `atascado — lleva más de ${f.stuckAfterHours}h refrescando`;
    case "due":
    default:
      return "obsoleto, sin ciclo iniciado";
  }
}

function freshnessTone(kind: ConnectorFreshnessState["kind"]): "on" | "off" | "muted" {
  if (kind === "fresh") return "on";
  if (kind === "stuck") return "off";
  return "muted";
}

/**
 * The "Frescura deseada" control + current-state readout (issue #295, D-050).
 * Rendered for every connector, including capture-only ones — the interval is a
 * valid knob for them (it doubles as #289's manual-capture staleness window).
 */
function FreshnessControl({
  connector,
  busy,
  onPatch,
}: {
  connector: ConnectorView;
  busy: boolean;
  onPatch: (patch: ConnectorConfigPatch) => void;
}) {
  const f = connector.freshness;
  // The stored override might not match a preset (e.g. an API-set 48h). Surface
  // it as an extra option so the select never silently misrepresents state.
  const presets = [...FRESHNESS_PRESETS];
  if (
    f.intervalHours !== null &&
    !presets.some((p) => p.hours === f.intervalHours)
  ) {
    presets.push({ label: `${f.intervalHours} h (personalizado)`, hours: f.intervalHours });
  }
  const currentValue = f.intervalHours === null ? "" : String(f.intervalHours);

  return (
    <div style={{ marginTop: 12 }} data-testid={`freshness-${connector.name}`}>
      <span style={labelStyle}>Frescura deseada</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={currentValue}
          disabled={busy}
          data-testid={`freshness-interval-${connector.name}`}
          onChange={(e) => {
            const v = e.target.value;
            onPatch({ freshness_interval_hours: v === "" ? null : Number(v) });
          }}
          style={{
            padding: "6px 9px",
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 13,
          }}
        >
          {presets.map((p) => (
            <option key={p.label} value={p.hours === null ? "" : String(p.hours)}>
              {p.label}
            </option>
          ))}
        </select>
        <span
          data-testid={`freshness-state-${connector.name}`}
          style={{ fontSize: 12 }}
        >
          <Pill text={freshnessStateText(f)} tone={freshnessTone(f.kind)} />
        </span>
      </div>
      <p style={{ fontSize: 11, color: "var(--fg-muted)", margin: "4px 0 0" }}>
        Cada cuánto se refrescan los datos de este conector. Por defecto{" "}
        {f.effectiveIntervalHours} h. El barrido programado solo inicia un ciclo
        cuando los datos superan este intervalo; una ejecución manual lo ignora.
      </p>
    </div>
  );
}

export function ConnectorCard({
  connector,
  onPatch,
  onRunFinished,
}: {
  connector: ConnectorView;
  onPatch: (name: string, patch: ConnectorConfigPatch) => Promise<void>;
  /** Called after an ad-hoc "Ejecutar ahora" run finishes, so the parent can
   * refresh the last-run summary (issue #244). */
  onRunFinished?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Collapsed by default: the list must be browsable at a glance, so full
  // config/scope/last-run detail is hidden until the operator expands a row
  // (issue #264).
  const [expanded, setExpanded] = useState(false);
  const [editingScope, setEditingScope] = useState(false);
  const [draftScope, setDraftScope] = useState<LocationPickerValue>(() => ({
    center: connector.geography_override?.center ?? [40.4168, -3.7038],
    radiusKm: connector.geography_override?.radius_km ?? 10,
  }));
  const [roomsText, setRoomsText] = useState(
    connector.filters.rooms === undefined ? "" : String(connector.filters.rooms),
  );

  const run = async (patch: ConnectorConfigPatch) => {
    setBusy(true);
    try {
      await onPatch(connector.name, patch);
    } finally {
      setBusy(false);
    }
  };

  // Mirrors ConnectorFiltersSchema's write-side bounds so invalid input is
  // reported rather than silently discarded (a non-numeric value used to
  // coerce to NaN and clear the filter outright — issue #100 review).
  const roomsError: string | null = (() => {
    const trimmed = roomsText.trim();
    if (trimmed === "") return null; // empty = "no filter", a valid choice
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return "Introduce un número.";
    if (!Number.isInteger(n)) return "Debe ser un número entero.";
    if (n < 1 || n > 20) return "Debe estar entre 1 y 20.";
    return null;
  })();

  const supportsRooms = connector.supported_filters.includes("rooms");
  // A deregistered connector can never run again, so every control on it
  // would write config that takes effect nowhere. The API rejects such
  // writes with 409; the UI shouldn't offer them in the first place
  // (issue #100 review).
  const locked = !connector.registered;
  const configurable = connector.supports_discovery && !locked;

  // Issue #319 / D-055: ONE toggle per connector — the user sees a single
  // Activo/Desactivado state. What that maps to depends on the connector type:
  //   - normal crawl connector → `enabled` (the automated crawl).
  //   - capture-only connector → `capture_enabled` (whether extension captures
  //     are processed). Its crawl `enabled` flag is never shown or toggled: a
  //     capture-only portal's automated crawl is WAF-blocked and never runs,
  //     so exposing it would be a control that does nothing. "Solo captura"
  //     stays a descriptive badge, not a mode the user switches.
  // A disabled source is also hidden from the candidate feed (see
  // lib/db/source-active.ts) — the toggle is the single lever for both.
  const isCaptureOnly = !connector.supports_discovery;
  const active = isCaptureOnly ? connector.capture_enabled : connector.enabled;
  const toggleActive = () =>
    run(isCaptureOnly ? { capture_enabled: !active } : { enabled: !active });

  return (
    <div style={cardStyle} data-testid={`connector-${connector.name}`}>
      <div style={summaryRowStyle}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Ocultar detalles de ${connector.name}`
              : `Ver detalles de ${connector.name}`
          }
          style={expandButtonStyle}
          data-testid={`expand-${connector.name}`}
        >
          <span
            aria-hidden="true"
            style={{
              transition: "transform 0.15s",
              display: "inline-block",
              flexShrink: 0,
              color: "var(--fg-muted)",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▸
          </span>
          <h2
            style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: 0, flexShrink: 0 }}
          >
            {connector.name}
          </h2>
          <span data-testid={`status-${connector.name}`} style={{ flexShrink: 0 }}>
            {/* A disabled connector reads as neutral, not error (issue #319):
                "desactivado" is a deliberate operator choice, not a failure. */}
            <Pill text={active ? "activo" : "desactivado"} tone={active ? "on" : "muted"} />
          </span>
          {isCaptureOnly && <Pill text="solo captura" tone="muted" />}
          {!connector.registered && <Pill text="no registrado" tone="muted" />}
          {connector.usingDefaults && <Pill text="sin configurar" tone="muted" />}

          <span
            data-testid={`lastrun-summary-${connector.name}`}
            style={{
              fontSize: 12,
              color: "var(--fg-muted)",
              marginLeft: "auto",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {lastRunSummary(connector)}
          </span>
        </button>

        {/* Issue #319 / D-055: the ONE toggle. For a capture-only connector it
            writes `capture_enabled`; for a normal one it writes `enabled`. The
            user never sees two separate on/off states. */}
        <button
          type="button"
          onClick={toggleActive}
          disabled={busy || locked}
          title={
            locked
              ? "Este conector ya no está registrado en el ETL: su configuración no tendría ningún efecto."
              : undefined
          }
          style={{
            ...buttonStyle,
            flexShrink: 0,
            opacity: busy || locked ? 0.6 : 1,
            cursor: locked ? "not-allowed" : buttonStyle.cursor,
          }}
          data-testid={`toggle-${connector.name}`}
        >
          {active ? "Desactivar" : "Activar"}
        </button>
      </div>

      {expanded && (
        <div style={detailStyle} data-testid={`connector-detail-${connector.name}`}>
      {locked && (
        <p
          style={{ fontSize: 12, color: "var(--fg-muted)", margin: "8px 0 0" }}
          data-testid={`unregistered-note-${connector.name}`}
        >
          Ya no está registrado en el ETL, así que no volverá a ejecutarse. Se
          conserva sólo para que su historial de ejecuciones siga siendo legible.
        </p>
      )}

      <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: "8px 0 0" }}>
        {connector.rate_limit_per_minute ?? "—"} peticiones/min ·{" "}
        {connector.discovers_full_inventory
          ? "cobertura completa"
          : "cobertura parcial (sin detección de retirada)"}
      </p>

      <div style={{ marginTop: 12 }}>
        <span style={labelStyle}>Qué descargará</span>
        <ScopeSummary connector={connector} />
      </div>

      {/* Issue #295 (D-050): freshness cadence — valid for every connector,
          capture-only included (it's #289's manual-capture staleness window). */}
      <FreshnessControl connector={connector} busy={busy} onPatch={run} />

      {/* Issue #319 / D-055: a capture-only connector has a single Activo/
          Desactivado toggle (the row above) that controls whether extension
          captures are processed — there is no separate crawl control, because
          its automated crawl is WAF-blocked and never runs. This note just
          describes what the connector is. */}
      {isCaptureOnly && (
        <div style={{ marginTop: 12 }} data-testid={`capture-note-${connector.name}`}>
          <span style={labelStyle}>Solo captura</span>
          <p style={{ fontSize: 11, color: "var(--fg-muted)", margin: "2px 0 0" }}>
            Este conector no realiza rastreo automático (bloqueado por el
            portal). Sus anuncios entran mediante la extensión de navegador. El
            botón Activar/Desactivar de la fila controla si esas capturas se
            procesan; al desactivarlo, sus anuncios dejan de aparecer en los
            candidatos.
          </p>
        </div>
      )}

      {configurable && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 6,
            background: "var(--bg-2)",
            fontSize: 12,
            color: "var(--fg-muted)",
          }}
          data-testid={`whole-city-warning-${connector.name}`}
        >
          Nota: la descarga siempre es a nivel de ciudad completa, aunque el radio
          sea pequeño — los portales no permiten buscar por radio arbitrario. El
          radio se aplica después, al filtrar los candidatos (ver #96).
        </div>
      )}

      {configurable && (
        <div style={{ marginTop: 12 }}>
          <span style={labelStyle}>Ámbito geográfico</span>
          {editingScope ? (
            <div>
              <LocationPicker value={draftScope} onChange={setDraftScope} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  disabled={busy}
                  style={{ ...buttonStyle, background: "var(--accent)", color: "#fff" }}
                  data-testid={`save-scope-${connector.name}`}
                  onClick={async () => {
                    const override: GeographyOverride = {
                      center: draftScope.center,
                      radius_km: draftScope.radiusKm,
                    };
                    await run({ geography_override: override });
                    setEditingScope(false);
                  }}
                >
                  Guardar ámbito
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => setEditingScope(false)}
                  disabled={busy}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setEditingScope(true)}
                disabled={busy}
                data-testid={`edit-scope-${connector.name}`}
              >
                {connector.geography_override ? "Editar ámbito" : "Definir ámbito explícito"}
              </button>
              {connector.geography_override && (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  data-testid={`clear-scope-${connector.name}`}
                  // null (not undefined) — explicitly clears the override so
                  // the connector goes back to the profile-derived default.
                  onClick={() => run({ geography_override: null })}
                >
                  Volver a perfiles
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {configurable && supportsRooms && (
        <div style={{ marginTop: 12 }}>
          <span style={labelStyle}>Habitaciones (coincidencia exacta)</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              inputMode="numeric"
              value={roomsText}
              onChange={(e) => setRoomsText(e.target.value)}
              placeholder="cualquiera"
              data-testid={`rooms-${connector.name}`}
              style={{
                width: 120,
                padding: "6px 9px",
                background: "var(--bg-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--fg)",
                fontSize: 13,
              }}
            />
            <button
              type="button"
              style={buttonStyle}
              disabled={busy || roomsError !== null}
              data-testid={`save-rooms-${connector.name}`}
              onClick={() => {
                const trimmed = roomsText.trim();
                // Empty clears the filter entirely rather than sending 0 —
                // `Number("") === 0` would otherwise persist a nonsense
                // "exactly zero rooms" filter (same coercion bug fixed in
                // the location picker, PR #103). Anything non-empty is
                // already known-valid here: `roomsError` gates the button,
                // so garbage can no longer silently clear the filter
                // instead of reporting itself (issue #100 review).
                if (trimmed === "") {
                  run({ filters: {} });
                  return;
                }
                run({ filters: { rooms: Number(trimmed) } });
              }}
            >
              Guardar
            </button>
          </div>
          {roomsError !== null && (
            <p
              style={{ fontSize: 11, color: "var(--danger, #d33)", margin: "4px 0 0" }}
              data-testid={`rooms-error-${connector.name}`}
            >
              {roomsError}
            </p>
          )}
          <p style={{ fontSize: 11, color: "var(--fg-muted)", margin: "4px 0 0" }}>
            Filtro nativo del portal: devuelve solo anuncios con exactamente ese
            número de habitaciones (no &ldquo;o más&rdquo;). Déjalo vacío para no
            filtrar por habitaciones.
          </p>
        </div>
      )}

      {connector.registered && connector.supports_discovery && (
        <div style={{ marginTop: 12 }}>
          <span style={labelStyle}>Ejecución bajo demanda</span>
          <div style={{ marginTop: 4 }}>
            <RunNowButton
              connectorName={connector.name}
              testIdSuffix={connector.name}
              onFinished={onRunFinished}
            />
          </div>
          <p style={{ fontSize: 11, color: "var(--fg-muted)", margin: "6px 0 0" }}>
            Lanza este conector ahora, sin esperar al barrido programado. Si hay
            un barrido en curso, la ejecución espera a que termine.
          </p>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <span style={labelStyle}>Última ejecución</span>
        {connector.lastRun ? (
          <p
            style={{ fontSize: 12, color: "var(--fg-muted)", margin: "2px 0 0" }}
            data-testid={`lastrun-${connector.name}`}
          >
            {connector.lastRun.status} · {connector.lastRun.discovered_count} descubiertos ·{" "}
            {connector.lastRun.fetched_count} descargados · {connector.lastRun.error_count} errores
            {connector.lastRun.started_at
              ? ` · ${new Date(connector.lastRun.started_at).toLocaleString("es-ES")}`
              : ""}
            {connector.lastRun.error_msg ? ` — ${connector.lastRun.error_msg}` : ""}
          </p>
        ) : (
          <p
            style={{ fontSize: 12, color: "var(--fg-muted)", margin: "2px 0 0" }}
            data-testid={`lastrun-${connector.name}`}
          >
            Nunca se ha ejecutado.
          </p>
        )}
      </div>
        </div>
      )}
    </div>
  );
}
