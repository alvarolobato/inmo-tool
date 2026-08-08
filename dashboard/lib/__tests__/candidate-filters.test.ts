import { describe, it, expect } from "vitest";
import {
  DEFAULT_CANDIDATE_FILTERS,
  candidateFiltersToParams,
  candidateFiltersToSearch,
  hasActiveFilters,
  moreFiltersActiveCount,
  parseCandidateFilters,
  showRejectedFromView,
  trackedOnlyFromView,
  type CandidateFilters,
} from "@/lib/candidate-filters";

describe("candidate-filters: state ↔ URL round-trip", () => {
  it("defaults serialize to an empty query string", () => {
    expect(candidateFiltersToSearch(DEFAULT_CANDIDATE_FILTERS)).toBe("");
    expect(candidateFiltersToParams(DEFAULT_CANDIDATE_FILTERS).toString()).toBe(
      "",
    );
  });

  it("absent params parse back to the defaults", () => {
    expect(parseCandidateFilters("")).toEqual(DEFAULT_CANDIDATE_FILTERS);
    expect(parseCandidateFilters("?")).toEqual(DEFAULT_CANDIDATE_FILTERS);
    expect(parseCandidateFilters("?unrelated=1")).toEqual(
      DEFAULT_CANDIDATE_FILTERS,
    );
  });

  it("round-trips every filter through the URL (parse ∘ serialize = id)", () => {
    const full: CandidateFilters = {
      source: "fotocasa",
      occupancy: "occupied",
      conditionSel: "a_reformar:integral",
      minDiscount: "15",
      caveat: "venta_deuda",
      redflagType: "embargo",
      beachProximity: "frontline",
      heritageZone: true,
      isVpo: "false",
      hasAlerts: true,
      view: "descartadas",
    };
    const search = candidateFiltersToSearch(full);
    expect(parseCandidateFilters(search)).toEqual(full);
  });

  it("#466: the 'Con alertas' toggle maps to the alerts=1 URL param", () => {
    const f: CandidateFilters = { ...DEFAULT_CANDIDATE_FILTERS, hasAlerts: true };
    const p = candidateFiltersToParams(f);
    expect(p.get("alerts")).toBe("1");
    // Round-trips, and a default (off) emits nothing.
    expect(parseCandidateFilters("?alerts=1").hasAlerts).toBe(true);
    expect(candidateFiltersToParams(DEFAULT_CANDIDATE_FILTERS).get("alerts")).toBeNull();
    // hasActiveFilters picks up the primary-row toggle.
    expect(hasActiveFilters(f)).toBe(true);
    // …but it is NOT one of the "Más filtros" popover group (primary row).
    expect(moreFiltersActiveCount(f)).toBe(0);
  });

  it("maps state keys to the spec'd URL param names (cond/redflag/beach/heritage/vpo)", () => {
    const f: CandidateFilters = {
      ...DEFAULT_CANDIDATE_FILTERS,
      conditionSel: "reformado",
      redflagType: "litigio",
      beachProximity: "sea_view",
      heritageZone: true,
      isVpo: "true",
    };
    const p = candidateFiltersToParams(f);
    expect(p.get("cond")).toBe("reformado");
    expect(p.get("redflag")).toBe("litigio");
    expect(p.get("beach")).toBe("sea_view");
    expect(p.get("heritage")).toBe("true");
    expect(p.get("vpo")).toBe("true");
    // The state-key names are NOT the param names.
    expect(p.get("conditionSel")).toBeNull();
    expect(p.get("redflagType")).toBeNull();
  });

  it("view: absent = Todas; seguimiento/descartadas are the only other reachable states", () => {
    expect(parseCandidateFilters("").view).toBe("all");
    expect(parseCandidateFilters("?view=seguimiento").view).toBe("seguimiento");
    expect(parseCandidateFilters("?view=descartadas").view).toBe("descartadas");
    // Unknown value falls back to the default (Todas).
    expect(parseCandidateFilters("?view=bogus").view).toBe("all");
  });
});

describe("candidate-filters: view mutual exclusion", () => {
  it("derives the two (formerly mutually-exclusive) booleans from the segment", () => {
    expect(trackedOnlyFromView("all")).toBe(false);
    expect(showRejectedFromView("all")).toBe(false);

    expect(trackedOnlyFromView("seguimiento")).toBe(true);
    expect(showRejectedFromView("seguimiento")).toBe(false);

    expect(trackedOnlyFromView("descartadas")).toBe(false);
    expect(showRejectedFromView("descartadas")).toBe(true);
  });

  it("no reachable view makes both booleans true at once", () => {
    for (const view of ["all", "seguimiento", "descartadas"] as const) {
      expect(trackedOnlyFromView(view) && showRejectedFromView(view)).toBe(
        false,
      );
    }
  });
});

describe("candidate-filters: active counts", () => {
  it("moreFiltersActiveCount counts only the 7 AI-gated popover filters", () => {
    expect(moreFiltersActiveCount(DEFAULT_CANDIDATE_FILTERS)).toBe(0);
    // source/minDiscount/view are NOT in the popover group.
    expect(
      moreFiltersActiveCount({
        ...DEFAULT_CANDIDATE_FILTERS,
        source: "idealista",
        minDiscount: "20",
        view: "seguimiento",
      }),
    ).toBe(0);
    expect(
      moreFiltersActiveCount({
        ...DEFAULT_CANDIDATE_FILTERS,
        occupancy: "free",
        caveat: "usufructo",
        heritageZone: true,
      }),
    ).toBe(3);
  });

  it("hasActiveFilters is true for any non-default filter (incl. source/minDiscount/view)", () => {
    expect(hasActiveFilters(DEFAULT_CANDIDATE_FILTERS)).toBe(false);
    expect(
      hasActiveFilters({ ...DEFAULT_CANDIDATE_FILTERS, source: "fotocasa" }),
    ).toBe(true);
    expect(
      hasActiveFilters({ ...DEFAULT_CANDIDATE_FILTERS, minDiscount: "10" }),
    ).toBe(true);
    expect(
      hasActiveFilters({ ...DEFAULT_CANDIDATE_FILTERS, view: "descartadas" }),
    ).toBe(true);
    expect(
      hasActiveFilters({ ...DEFAULT_CANDIDATE_FILTERS, isVpo: "true" }),
    ).toBe(true);
  });
});
