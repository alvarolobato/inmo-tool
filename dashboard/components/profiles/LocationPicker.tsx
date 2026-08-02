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

export function LocationPicker({
  value,
  onChange,
}: {
  value: LocationPickerValue;
  onChange: (next: LocationPickerValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) {
      setResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      fetch(`/api/geocode?q=${encodeURIComponent(query.trim())}`)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw isApiErrorResponse(body) ? new Error(body.error) : new Error("No se pudo buscar la ubicación.");
          }
          return res.json();
        })
        .then((body: { items: GeocodeResult[] }) => {
          setResults(body.items);
          setShowResults(true);
          setSearchError(null);
        })
        .catch((err) => {
          setResults([]);
          setSearchError(err instanceof Error ? err.message : "No se pudo buscar la ubicación.");
        })
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const selectResult = (result: GeocodeResult) => {
    onChange({ center: [result.lat, result.lon], radiusKm: value.radiusKm });
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
        <input
          type="number"
          min={0.1}
          step="any"
          value={value.radiusKm}
          onChange={(e) => onChange({ center: value.center, radiusKm: Number(e.target.value) })}
          style={{ ...inputStyle, maxWidth: 140 }}
          data-testid="location-radius-input"
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
            <input
              type="number"
              step="any"
              value={value.center[0]}
              onChange={(e) => onChange({ center: [Number(e.target.value), value.center[1]], radiusKm: value.radiusKm })}
              style={inputStyle}
              data-testid="location-lat-input"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Longitud</label>
            <input
              type="number"
              step="any"
              value={value.center[1]}
              onChange={(e) => onChange({ center: [value.center[0], Number(e.target.value)], radiusKm: value.radiusKm })}
              style={inputStyle}
              data-testid="location-lon-input"
            />
          </div>
        </div>
      )}
    </div>
  );
}
