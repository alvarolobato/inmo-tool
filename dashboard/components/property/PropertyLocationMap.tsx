"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Circle, useMap } from "react-leaflet";
import L from "leaflet";
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
 *
 * The zoom is derived from the circle, not hard-coded (#459): `FitToRadius`
 * fits the map to the circle's bounds so the whole approximate-location circle
 * is framed with a little context regardless of the radius, instead of an
 * arbitrary fixed zoom that could crop the circle or leave it a tiny dot.
 *
 * #594: the `interactive` prop (default false, unchanged grid-tile behaviour)
 * lets `PhotoGallery`'s lightbox reuse this exact component for the enlarged
 * map slide, where panning IS the point — dragging/scroll-wheel-zoom/
 * double-click-zoom/box-zoom/touch-zoom all follow `interactive`, and a
 * zoom control + attribution are shown. `keyboard` stays hard-`false` even
 * when interactive: the lightbox's own ArrowLeft/ArrowRight must keep
 * stepping slides, never pan the map — ceding keyboard to Leaflet here would
 * fight that (see PhotoGallery.tsx's gesture-conflict decision).
 */

/** Approximate-location circle radius, in metres. */
const APPROX_RADIUS_METERS = 300;

/**
 * Bounds that exactly contain the approximate-location circle — the same square
 * a Leaflet `Circle` reports from `getBounds()` (side = diameter = 2 * radius).
 * Pure geometry (no map/DOM), so it is unit-testable on its own.
 */
export function radiusBounds(
  lat: number,
  lon: number,
  radiusMeters: number,
): L.LatLngBounds {
  return L.latLng(lat, lon).toBounds(radiusMeters * 2);
}

/**
 * Fits the map viewport to the circle's bounds (with a little padding for
 * context) once the map is ready. Lives as a child of <MapContainer> so it can
 * grab the live map instance via useMap(); programmatic fitBounds works even
 * though all interaction handlers are disabled on the container.
 */
function FitToRadius({
  lat,
  lon,
  radiusMeters,
}: {
  lat: number;
  lon: number;
  radiusMeters: number;
}) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(radiusBounds(lat, lon, radiusMeters), { padding: [24, 24] });
  }, [map, lat, lon, radiusMeters]);
  return null;
}

export function PropertyLocationMap({
  lat,
  lon,
  radiusMeters = APPROX_RADIUS_METERS,
  interactive = false,
}: {
  lat: number;
  lon: number;
  radiusMeters?: number;
  interactive?: boolean;
}) {
  return (
    <div
      data-testid="property-location-map"
      style={{ width: "100%", height: "100%" }}
    >
      <MapContainer
        center={[lat, lon]}
        // Initial zoom is a placeholder — FitToRadius reframes to the circle's
        // bounds on mount, so the final zoom always frames the radius (#459).
        zoom={14}
        style={{ width: "100%", height: "100%" }}
        // Static grid tile (default): no interaction affordances, so it never
        // fights the page for scroll/keyboard. Lightbox map slide (#594):
        // `interactive` flips on every pan/zoom affordance EXCEPT keyboard —
        // see the class docstring for why keyboard stays off unconditionally.
        zoomControl={interactive}
        attributionControl={interactive}
        dragging={interactive}
        scrollWheelZoom={interactive}
        doubleClickZoom={interactive}
        boxZoom={interactive}
        keyboard={false}
        touchZoom={interactive}
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
        <FitToRadius lat={lat} lon={lon} radiusMeters={radiusMeters} />
      </MapContainer>
    </div>
  );
}
