"use client";

import { MapContainer, TileLayer, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";

/**
 * A small, single-property location map (#448 I) shown as the FIRST tile of
 * the detail photo gallery. It draws a CIRCLE (not a pin) at the property's
 * coordinates, because the location a portal publishes is deliberately
 * approximate — a circle communicates "somewhere in this area" honestly,
 * where a precise pin would over-claim.
 *
 * Same mapping stack the profile candidate map already uses (react-leaflet +
 * Leaflet + OpenStreetMap tiles, issue #43) — no API key, appropriate for a
 * self-hosted personal tool. Leaflet touches `window` at import time, so this
 * component MUST be loaded via `next/dynamic` with `ssr:false` (PhotoGallery
 * does exactly that) — the same "works in a component test, breaks in the real
 * browser under SSR" bug class the candidate map's docstring calls out.
 *
 * The map is a static preview: pan/zoom/keyboard interaction are disabled so
 * it never steals scroll or focus from the surrounding gallery grid — it's a
 * "where is this" glance, not an interactive map (that lives at
 * /profiles/[id]/map). The circle radius is a fixed approximation.
 */

/** Approximate-location circle radius, in metres. */
const APPROX_RADIUS_METERS = 300;

export function PropertyLocationMap({
  lat,
  lon,
  radiusMeters = APPROX_RADIUS_METERS,
}: {
  lat: number;
  lon: number;
  radiusMeters?: number;
}) {
  return (
    <div
      data-testid="property-location-map"
      style={{ width: "100%", height: "100%" }}
    >
      <MapContainer
        center={[lat, lon]}
        zoom={14}
        style={{ width: "100%", height: "100%" }}
        // Static preview: no interaction affordances, so it never fights the
        // page for scroll/keyboard the way a full interactive map would.
        zoomControl={false}
        attributionControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        boxZoom={false}
        keyboard={false}
        touchZoom={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <Circle
          center={[lat, lon]}
          radius={radiusMeters}
          // pathOptions.className is forwarded onto the SVG <path> Leaflet
          // renders for the circle — a stable hook for e2e (react-leaflet drops
          // arbitrary props like data-testid on vector layers, same caveat the
          // candidate map's divIcon comment documents for <Marker>).
          pathOptions={{
            className: "property-location-circle",
            color: "var(--accent, #4f46e5)",
            weight: 2,
            fillColor: "var(--accent, #4f46e5)",
            fillOpacity: 0.15,
          }}
        />
      </MapContainer>
    </div>
  );
}
