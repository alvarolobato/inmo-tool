"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import Link from "next/link";
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
 * breaks under Next.js SSR otherwise — exactly the class of "works in a
 * component test, breaks in the real browser" bug three prior dashboard
 * tasks each shipped once.
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

/**
 * Only numeric values are ever interpolated into the divIcon HTML strings
 * below today — `escapeHtml` is defensive, for the day someone adds a
 * free-text field (e.g. `address`, which is scraped, externally-controlled
 * data) to the icon markup without thinking about it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const markerIconCache = new Map<string, L.DivIcon>();

function singleMarkerIcon(propertyId: number): L.DivIcon {
  const key = `single:${propertyId}`;
  const cached = markerIconCache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    html: `<div data-testid="map-marker" data-property-id="${escapeHtml(String(propertyId))}" style="
      width:22px;height:22px;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:#dc2626;border:2px solid #fff;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    "></div>`,
    className: "candidate-marker-icon",
    iconSize: [22, 22],
    // The visual tip of the rotated teardrop sits a few px below/right of
    // the icon's own bounding box center — anchor there, not at the naive
    // bottom-center of the unrotated box.
    iconAnchor: [11, 27],
    popupAnchor: [0, -27],
  });
  markerIconCache.set(key, icon);
  return icon;
}

function clusterIcon(count: number): L.DivIcon {
  const key = `cluster:${count}`;
  const cached = markerIconCache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    html: `<div data-testid="map-cluster" style="
      display:flex;align-items:center;justify-content:center;
      width:32px;height:32px;border-radius:50%;
      background:var(--accent,#4f46e5);color:#fff;
      font-size:13px;font-weight:600;border:2px solid #fff;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    ">${escapeHtml(String(count))}</div>`,
    className: "candidate-cluster-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
  markerIconCache.set(key, icon);
  return icon;
}

const MADRID_CENTER: [number, number] = [40.4168, -3.7038];

/**
 * Canonical pipeline_stage vocabulary + ordering, per etl/schema/init.sql's
 * CHECK constraint. Deliberately not derived from the candidate data (which
 * would silently diverge from the schema's authoritative list and sort
 * alphabetically instead of by pipeline order — the exact class of
 * vocabulary drift issue #16's merge-reconciliation logic warns against).
 */
const PIPELINE_STAGES = [
  "new",
  "reviewing",
  "interested",
  "contacted",
  "visited",
  "offer_made",
  "closed",
  "rejected",
] as const;

const PIPELINE_STAGE_LABELS: Record<(typeof PIPELINE_STAGES)[number], string> = {
  new: "Nuevo",
  reviewing: "En revisión",
  interested: "Interesa",
  contacted: "Contactado",
  visited: "Visitado",
  offer_made: "Oferta hecha",
  closed: "Cerrado",
  rejected: "Descartado",
};

interface Cluster {
  key: string;
  lat: number;
  lon: number;
  candidates: MapCandidateRow[];
}

/**
 * Clusters by on-screen pixel proximity at the map's *current* zoom, not by
 * a fixed lat/lon grid. A fixed-degree grid (the original v1 approach) is
 * either too coarse when zoomed in (permanently unreachable clusters — a
 * confirmed dead end, not cosmetic) or too fine when zoomed out, and hand-
 * tuning a zoom-to-degree formula is guesswork against whatever viewport
 * size a real browser actually has. Projecting to container pixels via the
 * live Leaflet map instance is what marker-clustering libraries do under
 * the hood, and adapts correctly to any zoom/viewport without a formula to
 * get wrong.
 */
const CLUSTER_PIXEL_RADIUS = 40;

function clusterByPixelProximity(map: L.Map, candidates: MapCandidateRow[]): Cluster[] {
  const groups = new Map<string, MapCandidateRow[]>();
  for (const c of candidates) {
    const point = map.latLngToContainerPoint([c.lat, c.lon]);
    const gx = Math.round(point.x / CLUSTER_PIXEL_RADIUS);
    const gy = Math.round(point.y / CLUSTER_PIXEL_RADIUS);
    const key = `${gx}:${gy}`;
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

/**
 * Fits the map to the filtered candidate set whenever it changes (mount,
 * or a stage-filter change) — without this, a fixed initial center/zoom
 * leaves filtered results potentially entirely off-screen with no
 * indication anything changed. Capped at maxZoom so a tight real-world
 * cluster (a handful of candidates in the same building/block) doesn't
 * zoom all the way to street level automatically.
 */
function FitToCandidates({ candidates }: { candidates: MapCandidateRow[] }) {
  const map = useMap();
  useEffect(() => {
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      map.setView([candidates[0].lat, candidates[0].lon], Math.min(map.getZoom(), 15) || 14);
      return;
    }
    const bounds = L.latLngBounds(candidates.map((c): [number, number] => [c.lat, c.lon]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [candidates, map]);
  return null;
}

/**
 * Computes clusters against the live map instance and re-clusters on every
 * zoom change (panning alone doesn't change relative pixel distances
 * between points, so zoomend is the only map event that needs to trigger a
 * recompute) and whenever the candidate set changes (stage filter).
 */
function ClusteredMarkers({ candidates, profileId }: { candidates: MapCandidateRow[]; profileId: number }) {
  const map = useMap();
  const [clusters, setClusters] = useState<Cluster[]>([]);

  const recompute = useCallback(() => {
    setClusters(clusterByPixelProximity(map, candidates));
  }, [map, candidates]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  useMapEvents({
    zoomend: recompute,
  });

  return (
    <>
      {clusters.map((cluster) =>
        cluster.candidates.length === 1 ? (
          <Marker
            key={cluster.key}
            position={[cluster.lat, cluster.lon]}
            icon={singleMarkerIcon(cluster.candidates[0].property_id)}
          >
            <Popup>
              <CandidatePopupContent candidate={cluster.candidates[0]} profileId={profileId} />
            </Popup>
          </Marker>
        ) : (
          <Marker
            key={cluster.key}
            position={[cluster.lat, cluster.lon]}
            icon={clusterIcon(cluster.candidates.length)}
          >
            <Popup>
              <div style={{ fontSize: 13, maxHeight: 220, overflowY: "auto" }}>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>
                  {cluster.candidates.length} candidatos en esta zona
                </p>
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {cluster.candidates.map((c) => (
                    <li key={c.property_id} style={{ padding: "3px 0", borderTop: "1px solid var(--border)" }}>
                      <Link
                        href={`/profiles/${profileId}/properties/${c.property_id}`}
                        data-testid="map-cluster-item-link"
                        data-property-id={c.property_id}
                        style={{ color: "var(--fg-muted, #666)" }}
                      >
                        {c.min_price !== null ? fmtEUR0(c.min_price) : "Precio no disponible"}
                        {c.address ? ` · ${c.address}` : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
                <ZoomIntoCluster lat={cluster.lat} lon={cluster.lon} />
              </div>
            </Popup>
          </Marker>
        ),
      )}
    </>
  );
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

function stageLabel(stage: string): string {
  return stage in PIPELINE_STAGE_LABELS
    ? PIPELINE_STAGE_LABELS[stage as (typeof PIPELINE_STAGES)[number]]
    : stage;
}

function CandidatePopupContent({ candidate, profileId }: { candidate: MapCandidateRow; profileId: number }) {
  const sources = [...new Set(candidate.listings.map((l) => l.source))].sort();
  const typeLabel = propertyTypeLabel(candidate.property_type);
  return (
    <div data-testid="map-popup" data-property-id={candidate.property_id} style={{ fontSize: 13, minWidth: 180 }}>
      <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
        {candidate.min_price !== null ? fmtEUR0(candidate.min_price) : "Precio no disponible"}
      </p>
      <p style={{ margin: "0 0 4px", color: "var(--fg-muted, #666)" }}>
        {[
          typeLabel,
          candidate.m2_built !== null ? `${candidate.m2_built} m²` : null,
          candidate.rooms !== null ? `${candidate.rooms} hab.` : null,
          candidate.address,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted, #666)" }}>
        Fuentes: {sources.join(" + ")}
      </p>
      <Link
        href={`/profiles/${profileId}/properties/${candidate.property_id}`}
        data-testid="map-popup-detail-link"
        style={{ margin: 0, fontSize: 12, color: "var(--accent, #4f46e5)" }}
      >
        Ver ficha de la propiedad →
      </Link>
    </div>
  );
}

export function CandidateMap({
  candidates,
  unplottableCount,
  truncated,
  profileId,
}: {
  candidates: MapCandidateRow[];
  unplottableCount: number;
  truncated: boolean;
  profileId: number;
}) {
  const [stageFilter, setStageFilter] = useState<string>("all");

  const stagesPresent = useMemo(() => new Set(candidates.map((c) => c.pipeline_stage)), [candidates]);
  const stages = PIPELINE_STAGES.filter((s) => stagesPresent.has(s));

  const filtered = useMemo(
    () => (stageFilter === "all" ? candidates : candidates.filter((c) => c.pipeline_stage === stageFilter)),
    [candidates, stageFilter],
  );

  const unplottableInFilter =
    stageFilter === "all"
      ? unplottableCount
      : // unplottableCount is only known in aggregate (the query never fetches
        // unplottable rows' stage — they're not selected at all); once a
        // stage filter is active we can't attribute the count accurately,
        // so hide it rather than show a number that might not match the
        // active filter.
        0;

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
                {stageLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {unplottableInFilter > 0 && (
          <span data-testid="map-unplottable-count" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            {unplottableInFilter} candidato{unplottableInFilter === 1 ? "" : "s"} sin coordenadas para mostrar en el
            mapa
          </span>
        )}
        {truncated && (
          <span data-testid="map-truncated-notice" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            Mostrando los primeros {candidates.length} candidatos con coordenadas — hay más de los que caben en el
            mapa.
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          No hay candidatos con coordenadas para esta selección.
        </p>
      ) : (
        <div style={{ height: 520, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
          <MapContainer center={MADRID_CENTER} zoom={12} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            <FitToCandidates candidates={filtered} />
            <ClusteredMarkers candidates={filtered} profileId={profileId} />
          </MapContainer>
        </div>
      )}
    </div>
  );
}
