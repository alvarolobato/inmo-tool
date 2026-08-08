// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import L from "leaflet";

import { radiusBounds } from "../PropertyLocationMap";

/**
 * Unit coverage for the zoom-to-radius wiring (#459). The map itself (Leaflet
 * canvas, tiles, fitBounds side effects) is exercised in a real browser; here
 * we lock the pure geometry that drives the fit: `radiusBounds` returns the
 * square that exactly frames the approximate-location circle, which is what
 * `map.fitBounds(radiusBounds(...))` uses so the whole radius is visible
 * instead of an arbitrary fixed zoom.
 */
describe("PropertyLocationMap radiusBounds", () => {
  const lat = 40.4168;
  const lon = -3.7038;

  it("frames a box whose side equals the circle's diameter (2 * radius)", () => {
    const radius = 300;
    const bounds = radiusBounds(lat, lon, radius);

    // Vertical extent of the framed box, measured on the ground.
    const heightM = L.latLng(bounds.getNorth(), lon).distanceTo(
      L.latLng(bounds.getSouth(), lon),
    );
    // Side of the box == diameter == 2 * radius, within ~2% (equirectangular
    // vs haversine approximation).
    expect(Math.abs(heightM - 2 * radius) / (2 * radius)).toBeLessThan(0.02);
  });

  it("contains the circle centre and grows with the radius", () => {
    const small = radiusBounds(lat, lon, 100);
    const large = radiusBounds(lat, lon, 1000);

    // The centre point sits inside the framed bounds.
    expect(small.contains(L.latLng(lat, lon))).toBe(true);

    // A larger radius frames a strictly larger area (map zooms out more).
    expect(large.getNorth() - large.getSouth()).toBeGreaterThan(
      small.getNorth() - small.getSouth(),
    );
    // The small circle's bounds fit entirely inside the large one.
    expect(large.contains(small)).toBe(true);
  });
});
