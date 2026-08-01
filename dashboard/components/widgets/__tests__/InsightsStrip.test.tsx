// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InsightsStrip } from "../InsightsStrip";
import type { InsightsStripWidget } from "@/lib/schema";

const makeWidget = (items: InsightsStripWidget["items"]): InsightsStripWidget => ({
  type: "insights_strip",
  items,
});

describe("InsightsStrip", () => {
  it("renders the correct number of insight cards", () => {
    render(
      <InsightsStrip
        widget={makeWidget([
          { kind: "down", title: "Tickets cayeron", body: "Mayor caída en tiendas 804, 159, 97." },
          { kind: "up", title: "Ticket medio +13,8%", body: "Subida del ticket compensa la caída." },
          { kind: "warn", title: "Margen 601 en alerta", body: "27,8% vs media 61,5%." },
        ])}
      />,
    );
    expect(screen.getByText("Tickets cayeron")).toBeDefined();
    expect(screen.getByText("Ticket medio +13,8%")).toBeDefined();
    expect(screen.getByText("Margen 601 en alerta")).toBeDefined();
  });

  it("renders icon glyphs per kind", () => {
    const { container } = render(
      <InsightsStrip
        widget={makeWidget([
          { kind: "up", title: "Up", body: "positive" },
          { kind: "down", title: "Down", body: "negative" },
          { kind: "warn", title: "Warn", body: "warning" },
        ])}
      />,
    );
    const icons = container.querySelectorAll("[aria-hidden='true']");
    const iconTexts = Array.from(icons).map((el) => el.textContent);
    expect(iconTexts).toContain("▲");
    expect(iconTexts).toContain("▼");
    expect(iconTexts).toContain("⚠");
  });

  it("renders body text for each item", () => {
    render(
      <InsightsStrip
        widget={makeWidget([
          { kind: "warn", title: "Alert", body: "Custom body text here." },
        ])}
      />,
    );
    expect(screen.getByText("Custom body text here.")).toBeDefined();
  });

  it("renders a single item without error", () => {
    render(
      <InsightsStrip
        widget={makeWidget([{ kind: "up", title: "Solo card", body: "Only one." }])}
      />,
    );
    expect(screen.getByText("Solo card")).toBeDefined();
  });

  it("renders grid with correct number of columns", () => {
    const { container } = render(
      <InsightsStrip
        widget={makeWidget([
          { kind: "up", title: "A", body: "a" },
          { kind: "down", title: "B", body: "b" },
        ])}
      />,
    );
    const grid = container.firstChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
  });
});
