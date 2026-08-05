// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/profiles",
}));

vi.mock("@/components/FreshnessContext", () => ({
  useFreshness: () => ({
    freshnessText: "Datos al día",
    freshnessStale: false,
    freshnessTooltip: null,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    style,
  }: {
    href: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
  }) => (
    <a href={href} style={style}>
      {children}
    </a>
  ),
}));

import { TopBar } from "../TopBar";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TopBar", () => {
  it("renders without error", () => {
    expect(() => render(<TopBar />)).not.toThrow();
  });

  it("no longer includes a standalone 'Inicio' link (issue #195 — / and /inicio render Perfiles)", () => {
    render(<TopBar />);
    expect(screen.queryByRole("link", { name: "Inicio" })).not.toBeInTheDocument();
  });

  it("'Perfiles' is the first navigation link", () => {
    render(<TopBar />);
    const nav = screen.getByRole("navigation");
    const links = nav.querySelectorAll("a");
    expect(links[0]).toHaveTextContent("Perfiles");
  });

  it("includes all expected navigation links in order", () => {
    render(<TopBar />);
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    const labels = links.map((l) => l.textContent?.trim());
    expect(labels).toEqual(["Perfiles", "Captura", "Conversaciones"]);
  });

  it("includes 'Captura' link (top-level execution UI, #268) right after Perfiles", () => {
    render(<TopBar />);
    const capturaLink = screen.getByRole("link", { name: "Captura" });
    expect(capturaLink).toBeInTheDocument();
    expect(capturaLink).toHaveAttribute("href", "/captura");
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    const labels = links.map((l) => l.textContent?.trim());
    expect(labels.indexOf("Captura")).toBe(labels.indexOf("Perfiles") + 1);
  });

  it("includes 'Conversaciones' link pointing to /conversations", () => {
    render(<TopBar />);
    const conversacionesLink = screen.getByRole("link", { name: "Conversaciones" });
    expect(conversacionesLink).toBeInTheDocument();
    expect(conversacionesLink).toHaveAttribute("href", "/conversations");
  });

  it("marks 'Perfiles' active on /profiles (and on / and /inicio, which now render it — issue #195)", () => {
    // Mocked pathname is '/profiles'; the Perfiles link should read as active.
    render(<TopBar />);
    const perfilesLink = screen.getByRole("link", { name: "Perfiles" });
    // Active links get background: var(--bg-2) and fontWeight 500
    expect(perfilesLink).toHaveStyle({ fontWeight: 500 });
  });
});
