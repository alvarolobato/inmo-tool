// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TopStoresTable } from "../TopStoresTable";
import type { HomeViewModel } from "@/lib/home-types";

const STORES: HomeViewModel["topStores"] = [
  { code: "611", name: "Madrid Serrano",      sales: 4920, delta:  0.082, deltaYoY:  0.031, spark: [3900,4100,4500,3800,4400,4300,4920], status: "ok",    streakWeeks: 0, margin: 0.521, returnsRate: 0.032, tickets: 42,  ticketMedio: 117.14 },
  { code: "622", name: "Barcelona Diagonal",  sales: 4180, delta:  0.041, deltaYoY:  0.012, spark: [3700,3900,4000,3850,4020,4100,4180], status: "ok",    streakWeeks: 0, margin: 0.498, returnsRate: 0.028, tickets: 38,  ticketMedio: 110.00 },
  { code: "608", name: "Valencia Colón",      sales: 3960, delta: -0.012, deltaYoY: -0.025, spark: [4000,4100,3950,4050,3900,4010,3960], status: "ok",    streakWeeks: 4, margin: 0.512, returnsRate: 0.041, tickets: 35,  ticketMedio: 113.14 },
  { code: "637", name: "Sevilla Nervión",     sales: 3740, delta:  0.024, deltaYoY:  0.008, spark: [3500,3650,3700,3550,3680,3620,3740], status: "ok",    streakWeeks: 0, margin: 0.489, returnsRate: 0.035, tickets: 33,  ticketMedio: 113.33 },
  { code: "606", name: "Bilbao Gran Vía",     sales: 3210, delta: -0.064, deltaYoY: -0.072, spark: [3450,3500,3380,3420,3300,3260,3210], status: "watch", streakWeeks: 0, margin: 0.503, returnsRate: 0.058, tickets: 30,  ticketMedio: 107.00 },
  { code: "612", name: "Málaga Larios",       sales: 3080, delta:  0.018, deltaYoY:  0.005, spark: [2900,2950,3000,2920,3050,3010,3080], status: "ok",    streakWeeks: 0, margin: 0.517, returnsRate: 0.022, tickets: 28,  ticketMedio: 110.00 },
  { code: "601", name: "Zaragoza Independ.",  sales: 2820, delta: -0.142, deltaYoY: -0.200, spark: [3300,3250,3100,3000,2950,2880,2820], status: "alert", streakWeeks: 0, margin: 0.478, returnsRate: 0.019, tickets: 26,  ticketMedio: 108.46 },
  { code: "645", name: "A Coruña Real",       sales: 2680, delta:  0.012, deltaYoY: null,   spark: [2600,2650,2620,2640,2660,2670,2680], status: "ok",    streakWeeks: 0, margin: null,  returnsRate: null,  tickets: 0,   ticketMedio: 0 },
  { code: "157", name: "Granada Recogidas",   sales: 2540, delta: -0.034, deltaYoY: -0.018, spark: [2700,2680,2620,2580,2570,2560,2540], status: "ok",    streakWeeks: 0, margin: 0.491, returnsRate: 0.031, tickets: 24,  ticketMedio: 105.83 },
  { code: "632", name: "Murcia Trapería",     sales: 2410, delta:  0.052, deltaYoY:  0.044, spark: [2200,2280,2320,2350,2380,2390,2410], status: "ok",    streakWeeks: 0, margin: 0.506, returnsRate: 0.027, tickets: 22,  ticketMedio: 109.55 },
];

describe("TopStoresTable", () => {
  it("renders all 10 store rows", () => {
    render(<TopStoresTable stores={STORES} />);
    expect(screen.getByTestId("top-stores-table")).toBeInTheDocument();
    STORES.forEach((s) => {
      expect(screen.getByTestId(`store-row-${s.code}`)).toBeInTheDocument();
    });
  });

  it("renders store names", () => {
    render(<TopStoresTable stores={STORES} />);
    expect(screen.getByText("Madrid Serrano")).toBeInTheDocument();
    expect(screen.getByText("Murcia Trapería")).toBeInTheDocument();
  });

  it("renders store codes with accent color", () => {
    render(<TopStoresTable stores={STORES} />);
    expect(screen.getByText("611")).toBeInTheDocument();
    expect(screen.getByText("601")).toBeInTheDocument();
  });

  it("renders heat bars for all stores", () => {
    render(<TopStoresTable stores={STORES} />);
    STORES.forEach((s) => {
      expect(screen.getByTestId(`heat-bar-${s.code}`)).toBeInTheDocument();
    });
  });

  it("heat bar width is proportional to sales (max store has widest)", () => {
    render(<TopStoresTable stores={STORES} />);
    const maxStore = STORES[0]; // Madrid Serrano with 4920 is first
    const maxHeatBar = screen.getByTestId(`heat-bar-${maxStore.code}`);
    const style = maxHeatBar.getAttribute("style") ?? "";
    // Width should be the largest: 100 * 0.7 = 70px
    expect(style).toContain("70");
  });

  it("renders sequential rank numbers", () => {
    render(<TopStoresTable stores={STORES} />);
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("shows status dot color for 'alert' store (red)", () => {
    render(<TopStoresTable stores={STORES} />);
    const row = screen.getByTestId("store-row-601");
    const dot = row.querySelector('[title="Estado: alert"]');
    expect(dot?.getAttribute("style")).toContain("var(--down)");
  });

  it("shows status dot color for 'watch' store (yellow)", () => {
    render(<TopStoresTable stores={STORES} />);
    const row = screen.getByTestId("store-row-606");
    const dot = row.querySelector('[title="Estado: watch"]');
    expect(dot?.getAttribute("style")).toContain("var(--warn)");
  });

  it("renders margin column header", () => {
    render(<TopStoresTable stores={STORES} />);
    expect(screen.getByRole("columnheader", { name: "Margen" })).toBeInTheDocument();
  });

  it("renders margin % for stores with margin data", () => {
    render(<TopStoresTable stores={STORES} />);
    const cell = screen.getByTestId("margin-cell-611");
    // Intl.NumberFormat es-ES percent style produces "52,1 %" (narrow-no-break space)
    expect(cell.textContent).toMatch(/52[,.]1\s*%/);
  });

  it("renders em-dash for stores with null margin", () => {
    render(<TopStoresTable stores={STORES} />);
    const cell = screen.getByTestId("margin-cell-645");
    expect(cell.textContent).toBe("—");
  });

  describe("YoY column", () => {
    it("renders vs año ant column header", () => {
      render(<TopStoresTable stores={STORES} />);
      const headers = screen.getAllByRole("columnheader");
      const headerTexts = headers.map((h) => h.textContent);
      expect(headerTexts).toContain("vs año ant");
    });

    it("renders both vs media and vs año ant columns", () => {
      render(<TopStoresTable stores={STORES} />);
      const headers = screen.getAllByRole("columnheader");
      const headerTexts = headers.map((h) => h.textContent);
      expect(headerTexts).toContain("vs media");
      expect(headerTexts).toContain("vs año ant");
    });

    it("shows dash when deltaYoY is null", () => {
      render(<TopStoresTable stores={STORES} />);
      // Store "645" (A Coruña Real) has deltaYoY: null → should show "—"
      const row = screen.getByTestId("store-row-645");
      expect(row.textContent).toContain("—");
    });

    it("table has 12 column headers including Tickets and Tk medio", () => {
      render(<TopStoresTable stores={STORES} />);
      const headers = screen.getAllByRole("columnheader");
      expect(headers).toHaveLength(12);
      const texts = headers.map((h) => h.textContent);
      expect(texts).toEqual(["#", "Cód", "Tienda", "Ventas hoy", "Tickets", "Tk medio", "% Devol", "vs media", "vs año ant", "Margen", "Racha", "Últ. 7 días"]);
    });
  });

  describe("Tickets column", () => {
    it("renders tickets column header", () => {
      render(<TopStoresTable stores={STORES} />);
      expect(screen.getByRole("columnheader", { name: "Tickets" })).toBeInTheDocument();
    });

    it("renders tickets column with integer values", () => {
      render(<TopStoresTable stores={STORES} />);
      // Store "611" has tickets=42
      const cell = screen.getByTestId("tickets-611");
      expect(cell).toBeInTheDocument();
      expect(cell.textContent).toMatch(/42/);
    });

    it("renders 0 tickets as integer for store with no sales", () => {
      render(<TopStoresTable stores={STORES} />);
      // Store "645" has tickets=0
      const cell = screen.getByTestId("tickets-645");
      expect(cell.textContent).toMatch(/0/);
    });
  });

  describe("Tk medio column", () => {
    it("renders ticket medio column header", () => {
      render(<TopStoresTable stores={STORES} />);
      expect(screen.getByRole("columnheader", { name: "Tk medio" })).toBeInTheDocument();
    });

    it("renders ticket medio column with EUR values", () => {
      render(<TopStoresTable stores={STORES} />);
      // Store "611" has ticketMedio=117.14 → should show a EUR value
      const cell = screen.getByTestId("ticket-medio-611");
      expect(cell).toBeInTheDocument();
      expect(cell.textContent).toMatch(/€|—/);
      // Should NOT show dash (tickets=42 > 0)
      expect(cell.textContent).not.toBe("—");
    });

    it("renders dash when tickets is 0", () => {
      render(<TopStoresTable stores={STORES} />);
      // Store "645" has tickets=0
      const cell = screen.getByTestId("ticket-medio-645");
      expect(cell.textContent).toBe("—");
    });
  });

  describe("% Devol column (returnsRate)", () => {
    it("renders the '% Devol' column header", () => {
      render(<TopStoresTable stores={STORES} />);
      expect(screen.getByRole("columnheader", { name: "% Devol" })).toBeInTheDocument();
    });

    it("renders returnsRate cell for stores with data", () => {
      render(<TopStoresTable stores={STORES} />);
      // Madrid Serrano has returnsRate=0.032 → should show 3.2%
      const cell = screen.getByTestId("returns-rate-611");
      expect(cell).toBeInTheDocument();
      expect(cell.textContent).toMatch(/3[,.]2/); // locale-aware: "3,2 %" or "3.2 %"
    });

    it("renders dash for stores with null returnsRate", () => {
      render(<TopStoresTable stores={STORES} />);
      // A Coruña has returnsRate=null
      const cell = screen.getByTestId("returns-rate-645");
      expect(cell.textContent).toContain("—");
    });

    it("flags stores above network average by >1pp with down color", () => {
      // Bilbao has rate 5.8%; network avg ~0.033 (mean of non-null rates)
      // 0.058 - avg > 0.01 → should be flagged
      render(<TopStoresTable stores={STORES} />);
      const cell = screen.getByTestId("returns-rate-606");
      const span = cell.querySelector("span");
      expect(span?.getAttribute("style")).toContain("var(--down)");
    });

    it("uses networkReturnRate prop as threshold", () => {
      // With networkReturnRate=0.05, Bilbao (0.058) exceeds it by <1pp → no red
      render(<TopStoresTable stores={STORES} networkReturnRate={0.05} />);
      const cell = screen.getByTestId("returns-rate-606");
      const span = cell.querySelector("span");
      expect(span?.getAttribute("style")).not.toContain("var(--down)");

      // With networkReturnRate=0.02, Bilbao (0.058) exceeds by >1pp → red
      const { unmount } = render(<TopStoresTable stores={STORES} networkReturnRate={0.02} />);
      const cells = document.querySelectorAll('[data-testid="returns-rate-606"]');
      const lastCell = cells[cells.length - 1];
      const lastSpan = lastCell.querySelector("span");
      expect(lastSpan?.getAttribute("style")).toContain("var(--down)");
      unmount();
    });

    it("falls back to volume-weighted mean when networkReturnRate prop is null", () => {
      // 3 stores: A (sales=1000, rate=0.10), B (sales=9000, rate=0.01)
      // Volume-weighted mean = (1000*0.10 + 9000*0.01) / 10000 = 0.019
      // Store A (0.10) exceeds 0.019 + 0.01 = 0.029 → red
      // Store B (0.01) does NOT exceed 0.029 → muted
      const stores: HomeViewModel["topStores"] = [
        { code: "A01", name: "Store A", sales: 1000, delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 0.10 },
        { code: "B01", name: "Store B", sales: 9000, delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 0.01 },
      ];
      render(<TopStoresTable stores={stores} networkReturnRate={null} />);
      const cellA = screen.getByTestId("returns-rate-A01");
      const cellB = screen.getByTestId("returns-rate-B01");
      expect(cellA.querySelector("span")?.getAttribute("style")).toContain("var(--down)");
      expect(cellB.querySelector("span")?.getAttribute("style")).not.toContain("var(--down)");
    });

    it("outlier store does not suppress red flagging when using weighted approach", () => {
      // Outlier: 1 sale, 100% return rate (would pull arithmetic mean up to ~50%)
      // hiding genuinely elevated stores. With volume weighting the outlier
      // contributes negligibly.
      const stores: HomeViewModel["topStores"] = [
        { code: "OUT", name: "Outlier",   sales: 1,    delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 1.00 },
        { code: "BAD", name: "Bad store", sales: 5000, delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 0.08 },
        { code: "OK1", name: "Normal 1",  sales: 4000, delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 0.02 },
        { code: "OK2", name: "Normal 2",  sales: 4000, delta: 0, deltaYoY: null, spark: [], status: "ok", streakWeeks: 0, margin: null, returnsRate: 0.02 },
      ];
      // Weighted mean ≈ (1*1.0 + 5000*0.08 + 4000*0.02 + 4000*0.02) / 13001
      //              ≈ (1 + 400 + 80 + 80) / 13001 ≈ 0.0431
      // BAD (0.08) exceeds 0.0431 + 0.01 = 0.0531 → no, 0.08 > 0.0531 → red
      // Actually 0.08 - 0.0431 = 0.0369 > 0.01 → red flag
      render(<TopStoresTable stores={stores} networkReturnRate={null} />);
      const badCell = screen.getByTestId("returns-rate-BAD");
      expect(badCell.querySelector("span")?.getAttribute("style")).toContain("var(--down)");
    });
  });

  describe("inactive stores section", () => {
    const INACTIVE: HomeViewModel["inactiveStores"] = [
      { code: "104", name: "Funchal", lastSaleDate: "2020-09-30" },
      { code: "152", name: "Lisboa antigua", lastSaleDate: "2016-12-31" },
    ];

    it("does NOT render the toggle when there are no inactive stores", () => {
      render(<TopStoresTable stores={STORES} inactiveStores={[]} />);
      expect(screen.queryByTestId("inactive-stores-section")).not.toBeInTheDocument();
    });

    it("renders the 'Ver tiendas inactivas' toggle when there are inactive stores", () => {
      render(<TopStoresTable stores={STORES} inactiveStores={INACTIVE} />);
      expect(screen.getByTestId("inactive-stores-section")).toBeInTheDocument();
      expect(screen.getByText(/Ver tiendas inactivas \(2\)/)).toBeInTheDocument();
    });

    it("inactive list is collapsed initially", () => {
      render(<TopStoresTable stores={STORES} inactiveStores={INACTIVE} />);
      expect(screen.queryByText("Funchal")).not.toBeInTheDocument();
    });

    it("expands the list on toggle click and shows last sale date", () => {
      render(<TopStoresTable stores={STORES} inactiveStores={INACTIVE} />);
      fireEvent.click(screen.getByText(/Ver tiendas inactivas/));
      expect(screen.getByText("Funchal")).toBeInTheDocument();
      expect(screen.getByText(/últ. 2020-09-30/)).toBeInTheDocument();
    });
  });
});
