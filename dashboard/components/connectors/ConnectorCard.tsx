"use client";

import { useState } from "react";
import { LocationPicker, type LocationPickerValue } from "@/components/profiles/LocationPicker";
import type {
  ConnectorConfigPatch,
  ConnectorView,
  GeographyOverride,
} from "@/lib/connectors-schema";

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-1)",
  padding: 16,
  marginBottom: 12,
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

export function ConnectorCard({
  connector,
  onPatch,
}: {
  connector: ConnectorView;
  onPatch: (name: string, patch: ConnectorConfigPatch) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
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

  const supportsRooms = connector.supported_filters.includes("rooms");
  const configurable = connector.supports_discovery;

  return (
    <div style={cardStyle} data-testid={`connector-${connector.name}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", margin: 0 }}>
          {connector.name}
        </h2>
        <span data-testid={`status-${connector.name}`}>
          <Pill
            text={connector.enabled ? "activo" : "desactivado"}
            tone={connector.enabled ? "on" : "off"}
          />
        </span>
        {!connector.supports_discovery && <Pill text="solo captura" tone="muted" />}
        {!connector.registered && <Pill text="no registrado" tone="muted" />}
        {connector.usingDefaults && <Pill text="sin configurar" tone="muted" />}

        <button
          type="button"
          onClick={() => run({ enabled: !connector.enabled })}
          disabled={busy}
          style={{ ...buttonStyle, marginLeft: "auto", opacity: busy ? 0.6 : 1 }}
          data-testid={`toggle-${connector.name}`}
        >
          {connector.enabled ? "Desactivar" : "Activar"}
        </button>
      </div>

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
              disabled={busy}
              data-testid={`save-rooms-${connector.name}`}
              onClick={() => {
                const trimmed = roomsText.trim();
                // Empty clears the filter entirely rather than sending 0 —
                // `Number("") === 0` would otherwise persist a nonsense
                // "exactly zero rooms" filter (same coercion bug fixed in
                // the location picker, PR #103).
                const parsed = trimmed === "" ? undefined : Number(trimmed);
                run({
                  filters:
                    parsed !== undefined && Number.isFinite(parsed) ? { rooms: parsed } : {},
                });
              }}
            >
              Guardar
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--fg-muted)", margin: "4px 0 0" }}>
            Filtro nativo del portal: devuelve solo anuncios con exactamente ese
            número de habitaciones (no &ldquo;o más&rdquo;).
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
  );
}
