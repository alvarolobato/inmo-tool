"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { isApiErrorResponse } from "@/lib/errors";
import type { GeocodeResult } from "@/lib/geocode";

/**
 * Real location picker for a search profile's geography (issue #95),
 * replacing raw lat/lon number inputs: an address/place search box backed
 * by Nominatim (via /api/geocode) plus an interactive map preview with a
 * draggable marker and a radius circle.
 *
 * The Leaflet-touching part is a separate component loaded with
 * next/dynamic + ssr:false — see LocationPickerMap.tsx's docstring and
 * MapView.tsx (task 2.7) for why this split is required, not optional.
 */
const LocationPickerMap = dynamic(
  () => import("./LocationPickerMap").then((mod) => mod.LocationPickerMap),
  { ssr: false, loading: () => <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando mapa…</p> },
);

const SEARCH_DEBOUNCE_MS = 400;

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 9px",
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-muted)",
  marginBottom: 4,
};

export interface LocationPickerValue {
  center: [number, number];
  radiusKm: number;
}

/**
 * A numeric text input that keeps its own local string state, only
 * propagating a real number upward once the text parses to a finite value.
 *
 * Fixes a real bug (Opus review, PR #103): binding a plain <input
 * type="number"> directly to a numeric prop with `onChange={(e) =>
 * onChange(Number(e.target.value))}` coerces an empty string to `0` (JS's
 * `Number("") === 0`), which — for a lat/lng field — silently teleported
 * the map to [0, 0] (off the coast of Africa) the instant a user cleared
 * the field to type a new value, instead of treating "empty" as "not yet
 * entered." Tracking the raw text locally lets the field genuinely be
 * empty mid-edit without forcing a bogus numeric value on the parent.
 */
function NumericTextInput({
  value,
  onChange,
  min,
  style,
  testId,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  style?: React.CSSProperties;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));

  // Stay in sync when the value changes from outside this input (e.g. the
  // map picker or a search selection updating the coordinates) — but not
  // on every render, so this doesn't fight with the user's own typing.
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <input
      type="number"
      min={min}
      step="any"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") return; // genuinely empty — don't propagate 0
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      style={style}
      data-testid={testId}
    />
  );
}

export function LocationPicker({
  value,
  onChange,
}: {
  value: LocationPickerValue;
  onChange: (next: LocationPickerValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by selectResult() right before it calls setQuery(result.label), so
  // the effect below can tell "query changed because the user picked a
  // result" (skip re-searching) from "query changed because the user is
  // typing" (search for real). Without this, selecting a result set the
  // input's text to the full label, which re-triggered this same effect a
  // debounce-interval later — a redundant Nominatim request and the
  // dropdown reopening over the map the user had just interacted with.
  const skipNextSearchRef = useRef(false);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    if (query.trim().length < 3) {
      setResults([]);
      setSearchError(null);
      setSearched(false);
      return;
    }
    setSearching(true);
    // Stale-response guard: this component's own search box has no
    // hard limit on how fast a user can retype, and Nominatim's own
    // response latency isn't guaranteed to preserve request order, so an
    // older, slower request could otherwise resolve after a newer one and
    // overwrite its (more current) results. Mirrors the `cancelled` flag
    // pattern already established in components/map/MapView.tsx, plus a
    // real AbortController so the superseded request is actually cancelled
    // rather than just ignored on arrival.
    let cancelled = false;
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      const currentQuery = query.trim();
      fetch(`/api/geocode?q=${encodeURIComponent(currentQuery)}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw isApiErrorResponse(body) ? new Error(body.error) : new Error("No se pudo buscar la ubicación.");
          }
          return res.json();
        })
        .then((body: { items: GeocodeResult[] }) => {
          if (cancelled) return;
          setResults(body.items);
          setShowResults(true);
          setSearchError(null);
          setSearched(true);
        })
        .catch((err) => {
          if (cancelled || (err instanceof Error && err.name === "AbortError")) return;
          setResults([]);
          setSearchError(err instanceof Error ? err.message : "No se pudo buscar la ubicación.");
          setSearched(true);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const selectResult = (result: GeocodeResult) => {
    onChange({ center: [result.lat, result.lon], radiusKm: value.radiusKm });
    skipNextSearchRef.current = true;
    setQuery(result.label);
    setShowResults(false);
  };

  return (
    <div>
      <label style={labelStyle}>Buscar ubicación</label>
      <div style={{ position: "relative" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowResults(true)}
          placeholder="Ej: Chamberí, Madrid — o una dirección"
          style={inputStyle}
          data-testid="location-search-input"
        />
        {showResults && results.length > 0 && (
          <ul
            data-testid="location-search-results"
            style={{
              position: "absolute",
              // Well above Leaflet's own internal pane z-indexes (tile 200,
              // overlay 400, marker 600, popup 700) so the dropdown never
              // loses a stacking fight with the map below it regardless of
              // which Leaflet layer happens to render at this screen position.
              zIndex: 1000,
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              padding: 0,
              listStyle: "none",
              background: "var(--bg-1)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {results.map((r, i) => (
              <li key={`${r.lat},${r.lon},${i}`}>
                <button
                  type="button"
                  onClick={() => selectResult(r)}
                  data-testid="location-search-result"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 9px",
                    background: "none",
                    border: "none",
                    borderBottom: i < results.length - 1 ? "1px solid var(--border)" : "none",
                    color: "var(--fg)",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {searching && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--fg-muted)" }}>Buscando…</p>
      )}
      {!searching && searched && !searchError && results.length === 0 && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--fg-muted)" }}>
          Sin resultados para esta búsqueda.
        </p>
      )}
      {searchError && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--down)" }}>{searchError}</p>
      )}

      <div style={{ marginTop: 10 }}>
        <LocationPickerMap
          center={value.center}
          radiusKm={value.radiusKm}
          onCenterChange={(center) => onChange({ center, radiusKm: value.radiusKm })}
        />
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-subtle)" }}>
          Arrastra el marcador o haz clic en el mapa para ajustar el centro exacto.
        </p>
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={labelStyle}>Radio (km)</label>
        <NumericTextInput
          min={0.1}
          value={value.radiusKm}
          onChange={(radiusKm) => onChange({ center: value.center, radiusKm })}
          style={{ ...inputStyle, maxWidth: 140 }}
          testId="location-radius-input"
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        style={{
          marginTop: 10,
          padding: 0,
          border: "none",
          background: "none",
          color: "var(--fg-subtle)",
          fontSize: 12,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {showAdvanced ? "Ocultar" : "Introducir coordenadas manualmente"}
      </button>

      {showAdvanced && (
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Latitud</label>
            <NumericTextInput
              value={value.center[0]}
              onChange={(lat) => onChange({ center: [lat, value.center[1]], radiusKm: value.radiusKm })}
              style={inputStyle}
              testId="location-lat-input"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Longitud</label>
            <NumericTextInput
              value={value.center[1]}
              onChange={(lon) => onChange({ center: [value.center[0], lon], radiusKm: value.radiusKm })}
              style={inputStyle}
              testId="location-lon-input"
            />
          </div>
        </div>
      )}
    </div>
  );
}
