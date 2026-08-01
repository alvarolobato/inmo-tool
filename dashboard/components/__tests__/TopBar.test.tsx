// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/inicio",
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

  it("includes 'Inicio' as a navigation link", () => {
    render(<TopBar />);
    const inicioLink = screen.getByRole("link", { name: "Inicio" });
    expect(inicioLink).toBeInTheDocument();
    expect(inicioLink).toHaveAttribute("href", "/inicio");
  });

  it("'Inicio' is the first navigation link (before Paneles)", () => {
    render(<TopBar />);
    const nav = screen.getByRole("navigation");
    const links = nav.querySelectorAll("a");
    expect(links[0]).toHaveTextContent("Inicio");
    expect(links[1]).toHaveTextContent("Paneles");
  });

  it("includes all expected navigation links in order", () => {
    render(<TopBar />);
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    const labels = links.map((l) => l.textContent?.trim());
    expect(labels).toEqual(["Inicio", "Paneles", "Conversaciones", "Revisión", "Wren"]);
  });

  it("includes 'Conversaciones' link pointing to /conversations after Paneles", () => {
    render(<TopBar />);
    const conversacionesLink = screen.getByRole("link", { name: "Conversaciones" });
    expect(conversacionesLink).toBeInTheDocument();
    expect(conversacionesLink).toHaveAttribute("href", "/conversations");
  });

  it("Paneles link points to /paneles", () => {
    render(<TopBar />);
    const panelesLink = screen.getByRole("link", { name: "Paneles" });
    expect(panelesLink).toHaveAttribute("href", "/paneles");
  });

  it("marks '/inicio' link as active when on the inicio page", () => {
    // When pathname is '/inicio', the Inicio link should have bg-2 background style
    render(<TopBar />);
    const inicioLink = screen.getByRole("link", { name: "Inicio" });
    // Active links get background: var(--bg-2) and fontWeight 500
    expect(inicioLink).toHaveStyle({ fontWeight: 500 });
  });
});
