"use client";

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapCandidateRow } from "@/lib/map-candidates";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0 } from "@/components/widgets/format";

/**
 * Map view for a profile's matched candidates (task 2.7, #43).
 *
 * Leaflet + OpenStreetMap tiles: no API key required, appropriate for a
 * self-hosted personal tool (issue #43's own guidance) unlike a
 * Google-Maps-key-gated approach. Loaded via next/dynamic with ssr:false
 * from the parent page — Leaflet touches `window` at import time and
 * breaks under Next.js SSR otherwise (see docs/architecture/connectors.md-
 * style caution notes elsewhere in this project: this is exactly the class
 * of "works in a component test, breaks in the real browser" bug three
 * prior dashboard tasks each shipped once).
 *
 * All markers (single and cluster) use a custom `L.divIcon` with the test
 * hooks (`data-testid`, `data-property-id`) embedded directly in its HTML
 * string, rather than react-leaflet's default `<Marker icon={L.Icon.Default}>`.
 * This was a deliberate fix, not the original design: `<Marker>` only
 * forwards genuine Leaflet options (position/icon/eventHandlers) to the
 * element it creates — arbitrary props like `data-testid` are silently
 * dropped, confirmed live (real e2e run against a real browser returned 0
 * elements for a `data-testid` selector on `<Marker>` despite pins visibly
 * rendering) before switching to this approach. It also sidesteps Leaflet's
 * default-icon-path bug under bundlers (the icon URLs assume a plain
 * script-tag setup) without needing an external unpkg fallback.
 */
function singleMarkerIcon(propertyId: number): L.DivIcon {
  return L.divIcon({
    html: `<div data-testid="map-marker" data-property-id="${propertyId}" style="
      width:22px;height:22px;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:#dc2626;border:2px solid #fff;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    "></div>`,
    className: "candidate-marker-icon",
    iconSize: [22, 22],
    iconAnchor: [11, 22],
    popupAnchor: [0, -22],
  });
}

const MADRID_CENTER: [number, number] = [40.4168, -3.7038];

/**
 * Fixed-precision grid clustering — deliberately simple per issue #43's own
 * "a simple grid/marker-cluster approach is sufficient for v1, don't
 * over-engineer this" scope note. ~0.01 degrees is roughly 1km at Madrid's
 * latitude; not zoom-adaptive, which a production clustering library (e.g.
 * react-leaflet-cluster) would be, but that package currently requires
 * react-leaflet v5 / React 19 — a peer-dependency bump out of scope here.
 */
const CLUSTER_GRID_SIZE = 0.01;

interface Cluster {
  key: string;
  lat: number;
  lon: number;
  candidates: MapCandidateRow[];
}

function clusterCandidates(candidates: MapCandidateRow[]): Cluster[] {
  const groups = new Map<string, MapCandidateRow[]>();
  for (const c of candidates) {
    const gridLat = Math.round(c.lat / CLUSTER_GRID_SIZE);
    const gridLon = Math.round(c.lon / CLUSTER_GRID_SIZE);
    const key = `${gridLat}:${gridLon}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    lat: group.reduce((sum, c) => sum + c.lat, 0) / group.length,
    lon: group.reduce((sum, c) => sum + c.lon, 0) / group.length,
    candidates: group,
  }));
}

function clusterIcon(count: number): L.DivIcon {
  return L.divIcon({
    html: `<div data-testid="map-cluster" style="
      display:flex;align-items:center;justify-content:center;
      width:32px;height:32px;border-radius:50%;
      background:var(--accent,#4f46e5);color:#fff;
      font-size:13px;font-weight:600;border:2px solid #fff;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    ">${count}</div>`,
    className: "candidate-cluster-icon",
    iconSize: [32, 32],
  });
}

function ZoomIntoCluster({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  return (
    <button
      onClick={() => map.setView([lat, lon], Math.min(map.getZoom() + 3, 18))}
      style={{
        display: "block",
        marginTop: 6,
        padding: "4px 8px",
        fontSize: 12,
        border: "1px solid var(--border)",
        borderRadius: 4,
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
      }}
    >
      Acercar para separar
    </button>
  );
}

function propertyTypeLabel(type: string | null): string | null {
  if (type === null) return null;
  return type in PROPERTY_TYPE_LABELS
    ? PROPERTY_TYPE_LABELS[type as (typeof PROPERTY_TYPES)[number]]
    : type;
}

function CandidatePopupContent({ candidate }: { candidate: MapCandidateRow }) {
  const sources = [...new Set(candidate.listings.map((l) => l.source))].sort();
  const typeLabel = propertyTypeLabel(candidate.property_type);
  return (
    <div data-testid="map-popup" data-property-id={candidate.property_id} style={{ fontSize: 13, minWidth: 180 }}>
      <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
        {candidate.min_price !== null ? fmtEUR0(candidate.min_price) : "Precio no disponible"}
      </p>
      <p style={{ margin: "0 0 4px", color: "var(--fg-muted, #666)" }}>
        {[typeLabel, candidate.m2_built !== null ? `${candidate.m2_built} m²` : null, candidate.address]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted, #666)" }}>
        Fuentes: {sources.join(" + ")}
      </p>
      {/*
        No link to a property detail page yet: task 2.8 (#44, property
        detail page) doesn't exist in this stack yet — same gap
        CandidateCard (task 2.5) documented and deferred for the same
        reason. Issue #43's EC-3 asks for "a working link to that
        property's detail page"; since that page is real-but-not-built-yet
        rather than never-planned, showing a disabled affordance here
        (rather than a link that would 404) documents the intent honestly
        without shipping a broken link. Wire this up once #44 lands.
      */}
      <p
        data-testid="map-popup-detail-link-pending"
        style={{ margin: 0, fontSize: 11, color: "var(--fg-muted, #999)", fontStyle: "italic" }}
      >
        Ficha de propiedad — próximamente (#44)
      </p>
    </div>
  );
}

export function CandidateMap({
  candidates,
  unplottableCount,
}: {
  candidates: MapCandidateRow[];
  unplottableCount: number;
}) {
  const [stageFilter, setStageFilter] = useState<string>("all");

  const stages = useMemo(
    () => [...new Set(candidates.map((c) => c.pipeline_stage))].sort(),
    [candidates],
  );

  const filtered = useMemo(
    () => (stageFilter === "all" ? candidates : candidates.filter((c) => c.pipeline_stage === stageFilter)),
    [candidates, stageFilter],
  );

  const clusters = useMemo(() => clusterCandidates(filtered), [filtered]);

  const center: [number, number] =
    filtered.length > 0
      ? [
          filtered.reduce((sum, c) => sum + c.lat, 0) / filtered.length,
          filtered.reduce((sum, c) => sum + c.lon, 0) / filtered.length,
        ]
      : MADRID_CENTER;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Fase:{" "}
          <select
            data-testid="map-stage-filter"
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            style={{
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg-1)",
              color: "var(--fg)",
              fontSize: 13,
            }}
          >
            <option value="all">Todas</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {unplottableCount > 0 && (
          <span data-testid="map-unplottable-count" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            {unplottableCount} candidato{unplottableCount === 1 ? "" : "s"} sin coordenadas para mostrar en el mapa
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          No hay candidatos con coordenadas para esta selección.
        </p>
      ) : (
        <div style={{ height: 520, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
          <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            {clusters.map((cluster) =>
              cluster.candidates.length === 1 ? (
                <Marker
                  key={cluster.key}
                  position={[cluster.lat, cluster.lon]}
                  icon={singleMarkerIcon(cluster.candidates[0].property_id)}
                >
                  <Popup>
                    <CandidatePopupContent candidate={cluster.candidates[0]} />
                  </Popup>
                </Marker>
              ) : (
                <Marker
                  key={cluster.key}
                  position={[cluster.lat, cluster.lon]}
                  icon={clusterIcon(cluster.candidates.length)}
                >
                  <Popup>
                    <div style={{ fontSize: 13 }}>
                      <p style={{ margin: "0 0 6px", fontWeight: 600 }}>
                        {cluster.candidates.length} candidatos en esta zona
                      </p>
                      <ZoomIntoCluster lat={cluster.lat} lon={cluster.lon} />
                    </div>
                  </Popup>
                </Marker>
              ),
            )}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
