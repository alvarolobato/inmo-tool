"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Leaflet part of the search profile location picker (issue #95). Split out
 * from LocationPicker.tsx and loaded via next/dynamic with ssr:false by that
 * component — Leaflet touches `window` at import time and breaks under
 * Next.js SSR otherwise, the same "works in a component test, breaks in the
 * real browser" bug class this project has hit before (see CandidateMap.tsx,
 * task 2.7's docstring).
 */

const pinIcon = L.divIcon({
  html: `<div style="
    width:22px;height:22px;border-radius:50% 50% 50% 0;
    transform:rotate(-45deg);
    background:#4f46e5;border:2px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,0.4);
  "></div>`,
  className: "location-picker-marker-icon",
  iconSize: [22, 22],
  iconAnchor: [11, 27],
});

/**
 * Recenters the map view whenever `center` changes, whether that came from
 * a geocoded search selection (parent state update, map needs to pan there)
 * or from dragging/clicking the marker on this same map (map is already
 * roughly there, but re-centering on the exact dropped point is the
 * expected behavior for this kind of picker, not a fight against the
 * gesture — it just re-settles the view on release).
 */
function RecenterOnChange({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

function DraggableMarker({
  center,
  onDrag,
}: {
  center: [number, number];
  onDrag: (next: [number, number]) => void;
}) {
  return (
    <Marker
      position={center}
      icon={pinIcon}
      draggable
      eventHandlers={{
        dragend: (e) => {
          const marker = e.target as L.Marker;
          const pos = marker.getLatLng();
          onDrag([pos.lat, pos.lng]);
        },
      }}
    />
  );
}

function ClickToMove({ onClick }: { onClick: (next: [number, number]) => void }) {
  useMapEvents({
    click: (e) => onClick([e.latlng.lat, e.latlng.lng]),
  });
  return null;
}

export function LocationPickerMap({
  center,
  radiusKm,
  onCenterChange,
}: {
  center: [number, number];
  radiusKm: number;
  onCenterChange: (next: [number, number]) => void;
}) {
  return (
    <div style={{ height: 320, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
      <MapContainer center={center} zoom={13} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <RecenterOnChange center={center} />
        <ClickToMove onClick={onCenterChange} />
        <DraggableMarker center={center} onDrag={onCenterChange} />
        <Circle
          center={center}
          radius={radiusKm * 1000}
          // interactive=false: this is a visual radius indicator, not a
          // clickable object. Leaflet vector layers are interactive (and
          // capture pointer events, stopping them from reaching the map's
          // own click handler) by default — without this, clicking inside
          // the circle silently ate clicks meant for ClickToMove, and its
          // SVG path also intercepted clicks meant for unrelated page
          // elements overlapping it in the stacking order (confirmed live
          // via a real e2e run: a search-result dropdown item became
          // unclickable because the circle's <path> sat on top of it).
          interactive={false}
          pathOptions={{ color: "#4f46e5", fillOpacity: 0.1 }}
        />
      </MapContainer>
    </div>
  );
}
