// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * #594: the location-map tile becomes a lightbox slide. Real Leaflet is
 * deliberately NOT mounted here — this project's own convention
 * (PropertyLocationMap.test.tsx's docstring) is to exercise Leaflet itself
 * only in a real browser and keep jsdom unit tests to pure logic/DOM
 * structure. `next/dynamic` is mocked to a plain stub that records the props
 * `PhotoGallery` passes it (`lat`/`lon`/`interactive`), so these tests cover
 * the SLIDE-INDEXING contract this file actually owns: which slide is the
 * map, that the `N / M` counter never counts it, that arrow keys still step
 * off it, and that the lightbox's own swipe/pinch pointer tracking is
 * suspended while it's the active slide — without caring what Leaflet does
 * internally.
 */
vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPropertyLocationMap({
      lat,
      lon,
      interactive,
    }: {
      lat: number;
      lon: number;
      interactive?: boolean;
    }) {
      return (
        <div
          data-testid="property-location-map"
          data-lat={lat}
          data-lon={lon}
          data-interactive={interactive ? "true" : "false"}
        />
      );
    },
}));

import { PhotoGallery } from "@/components/property/PhotoGallery";

const PHOTOS = ["https://img/1.jpg", "https://img/2.jpg", "https://img/3.jpg"];
const LAT = 40.4168;
const LON = -3.7038;

function openMapSlide() {
  fireEvent.click(screen.getByTestId("photo-gallery-map-tile-open"));
}

function openLightboxAtPhoto(index: number) {
  fireEvent.click(screen.getAllByTestId("photo-gallery-thumb")[index]);
}

describe("PhotoGallery map-as-lightbox-slide (#594)", () => {
  it("opens the map, enlarged and interactive, when the map tile is tapped", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openMapSlide();

    const slide = screen.getByTestId("photo-gallery-map-slide");
    const map = slide.querySelector('[data-testid="property-location-map"]');
    expect(map).not.toBeNull();
    expect(map).toHaveAttribute("data-interactive", "true");
    // No photo is showing while the map slide is active.
    expect(screen.queryByTestId("photo-gallery-lightbox-image")).not.toBeInTheDocument();
  });

  it("never counts the map as a photo: counter is hidden on the map slide and reads 1 / 3 on the first real photo", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openMapSlide();
    // A real assertion the fix could fail: without the offset/gating logic
    // this would show something bogus like "1 / 3" while the map is open,
    // or "0 / 3" once stepped onto the first photo.
    expect(screen.queryByTestId("photo-gallery-counter")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("photo-gallery-next"));
    expect(screen.getByTestId("photo-gallery-counter")).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("photo-gallery-lightbox-image")).toHaveAttribute("src", PHOTOS[0]);
  });

  it("prev from the first photo lands on the map slide; prev again wraps to the last photo", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openLightboxAtPhoto(0);
    expect(screen.getByTestId("photo-gallery-counter")).toHaveTextContent("1 / 3");

    fireEvent.click(screen.getByTestId("photo-gallery-prev"));
    expect(screen.getByTestId("photo-gallery-map-slide")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-gallery-counter")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("photo-gallery-prev"));
    expect(screen.getByTestId("photo-gallery-counter")).toHaveTextContent("3 / 3");
    expect(screen.getByTestId("photo-gallery-lightbox-image")).toHaveAttribute("src", PHOTOS[2]);
  });

  it("ArrowRight steps off the map slide onto the first photo (keyboard is never suspended)", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openMapSlide();
    expect(screen.getByTestId("photo-gallery-map-slide")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.queryByTestId("photo-gallery-map-slide")).not.toBeInTheDocument();
    expect(screen.getByTestId("photo-gallery-lightbox-image")).toHaveAttribute("src", PHOTOS[0]);
  });

  it("closing the lightbox from the map slide returns focus to the map tile's own open button, not a photo thumbnail", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openMapSlide();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("photo-gallery-lightbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("photo-gallery-map-tile-open")).toHaveFocus();
  });

  it("suspends the lightbox's own swipe/pinch pointer tracking while the map slide is active", () => {
    render(<PhotoGallery photoUrls={PHOTOS} lat={LAT} lon={LON} />);
    openMapSlide();

    const zoomArea = screen.getByTestId("photo-gallery-zoom-area");
    // A real horizontal touch swipe — well past SWIPE_THRESHOLD_PX (50) —
    // that on a PHOTO slide would call step() and change the open slide.
    // This test can fail: without the `mapSlideActive` guard in
    // handleZoomPointer{Down,Move,End}, this exact sequence steps the
    // lightbox onto the first photo, same as the desktop button does above.
    fireEvent.pointerDown(zoomArea, { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(zoomArea, { pointerType: "touch", pointerId: 1, clientX: 150, clientY: 200 });
    fireEvent.pointerUp(zoomArea, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 200 });

    expect(screen.getByTestId("photo-gallery-map-slide")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-gallery-lightbox-image")).not.toBeInTheDocument();
  });

  it("with no photos at all, the map is still openable as the lightbox's only slide", () => {
    render(<PhotoGallery photoUrls={[]} lat={LAT} lon={LON} />);
    openMapSlide();
    expect(screen.getByTestId("photo-gallery-map-slide")).toBeInTheDocument();
    // A single slide: no prev/next, nothing to step to.
    expect(screen.queryByTestId("photo-gallery-next")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-gallery-prev")).not.toBeInTheDocument();
  });
});
