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

  // ── Issue #586 — freshness dot colour, fail dark never green ───────────
  //
  // The dot itself carries no data-testid (only the text span next to it
  // does); it is that span's previous sibling in the DOM, unaffected by the
  // `hidden md:inline` CSS class (still present in the DOM, just visually
  // hidden below md — issue #571) so this selector works regardless of
  // viewport.
  function dotElement(): HTMLElement {
    const pill = screen.getByTestId("freshness-indicator");
    return pill.previousElementSibling as HTMLElement;
  }

  it("dot is green ('--up') when nothing is stale, refreshing, or unknown", () => {
    render(<TopBar freshnessStale={false} freshnessUnknown={false} />);
    expect(dotElement()).toHaveStyle({ background: "var(--up)" });
  });

  it("dot is amber ('--warn') when stale", () => {
    render(<TopBar freshnessStale={true} freshnessUnknown={false} />);
    expect(dotElement()).toHaveStyle({ background: "var(--warn)" });
  });

  it("dot is grey ('--fg-muted'), never green, when the freshness state is unknown (DB error / empty scope)", () => {
    render(<TopBar freshnessStale={false} freshnessUnknown={true} />);
    expect(dotElement()).toHaveStyle({ background: "var(--fg-muted)" });
  });

  it("unknown takes priority over stale — never renders amber when the state can't be determined at all", () => {
    render(<TopBar freshnessStale={true} freshnessUnknown={true} />);
    expect(dotElement()).toHaveStyle({ background: "var(--fg-muted)" });
  });

  it("the dot carries its own accessible name (aria-label) — it is the only thing rendered below md, issue #586 review", () => {
    render(
      <TopBar
        freshnessText="Estado desconocido"
        freshnessStale={false}
        freshnessUnknown={true}
      />,
    );
    const dot = dotElement();
    expect(dot).toHaveAttribute("role", "status");
    expect(dot).toHaveAttribute("aria-label", "Estado desconocido");
    // Doesn't rely on the (mobile-hidden, `display:none`) text span, which
    // is also dropped from the accessibility tree there.
    const pill = screen.getByTestId("freshness-indicator");
    expect(pill).toHaveAttribute("aria-hidden", "true");
  });
});
