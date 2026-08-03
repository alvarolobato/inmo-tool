// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PhotoGallery } from "@/components/property/PhotoGallery";

const PHOTOS = ["https://img/1.jpg", "https://img/2.jpg", "https://img/3.jpg"];

function openLightboxAt(index: number) {
  fireEvent.click(screen.getAllByTestId("photo-gallery-thumb")[index]);
}

function enlargedSrc(): string | null {
  return screen.getByTestId("photo-gallery-lightbox").querySelector("img")?.getAttribute("src") ?? null;
}

describe("PhotoGallery lightbox navigation (#152)", () => {
  it("steps forward and backward through the photos with the nav buttons", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(0);
    expect(enlargedSrc()).toBe(PHOTOS[0]);

    fireEvent.click(screen.getByTestId("photo-gallery-next"));
    expect(enlargedSrc()).toBe(PHOTOS[1]);

    fireEvent.click(screen.getByTestId("photo-gallery-prev"));
    expect(enlargedSrc()).toBe(PHOTOS[0]);
  });

  it("navigates with ArrowRight / ArrowLeft", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(0);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(enlargedSrc()).toBe(PHOTOS[1]);

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(enlargedSrc()).toBe(PHOTOS[0]);
  });

  it("wraps around at both ends instead of dead-ending", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(0);

    // Backwards from the first photo lands on the last…
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(enlargedSrc()).toBe(PHOTOS[2]);

    // …and forwards from the last returns to the first.
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(enlargedSrc()).toBe(PHOTOS[0]);
  });

  it("hides the nav controls when there is only one photo", () => {
    render(<PhotoGallery photoUrls={[PHOTOS[0]]} />);
    openLightboxAt(0);
    expect(screen.queryByTestId("photo-gallery-next")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-gallery-prev")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-gallery-counter")).not.toBeInTheDocument();
  });

  it("shows the position counter and keeps it in step with navigation", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(1);
    expect(screen.getByTestId("photo-gallery-counter")).toHaveTextContent("2 / 3");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByTestId("photo-gallery-counter")).toHaveTextContent("3 / 3");
  });

  it("Escape still closes, and focus returns to the thumbnail of the photo being viewed — not the one first opened", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(0);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("photo-gallery-lightbox")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("photo-gallery-thumb")[2]).toHaveFocus();
  });

  it("keeps focus on the close button when the lightbox opens, and does not steal it back on every step", () => {
    render(<PhotoGallery photoUrls={PHOTOS} />);
    openLightboxAt(0);
    const close = screen.getByTestId("photo-gallery-lightbox-close");
    expect(close).toHaveFocus();

    // Move focus onto "next" the way a real click does, then step: focus must
    // stay put so a second click doesn't need re-aiming.
    const next = screen.getByTestId("photo-gallery-next");
    next.focus();
    fireEvent.click(next);
    expect(next).toHaveFocus();
  });
});
