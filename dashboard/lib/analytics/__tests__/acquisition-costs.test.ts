import { describe, it, expect } from "vitest";
import {
  computeAcquisitionCosts,
  resolveComunidadAutonoma,
  ITP_RATE_BY_CCAA,
  NATIONAL_FALLBACK_ITP_PCT,
  DEFAULT_NOTARY_PCT,
  DEFAULT_REGISTRY_PCT,
  DEFAULT_GESTORIA_EUR,
} from "../acquisition-costs";

describe("resolveComunidadAutonoma", () => {
  it("resolves a plain-ASCII province name", () => {
    expect(resolveComunidadAutonoma("Madrid")).toBe("Madrid");
  });

  it("is case- and accent-insensitive (a real connector-data gotcha: sources disagree on casing/accents)", () => {
    expect(resolveComunidadAutonoma("MÁLAGA")).toBe("Andalucía");
    expect(resolveComunidadAutonoma("malaga")).toBe("Andalucía");
    expect(resolveComunidadAutonoma("  Málaga  ")).toBe("Andalucía");
  });

  it("maps every one of Cataluña's four provinces", () => {
    expect(resolveComunidadAutonoma("Barcelona")).toBe("Cataluña");
    expect(resolveComunidadAutonoma("Girona")).toBe("Cataluña");
    expect(resolveComunidadAutonoma("Lleida")).toBe("Cataluña");
    expect(resolveComunidadAutonoma("Tarragona")).toBe("Cataluña");
  });

  it("returns null for an unrecognized or missing province", () => {
    expect(resolveComunidadAutonoma("Nowhereshire")).toBeNull();
    expect(resolveComunidadAutonoma(null)).toBeNull();
    expect(resolveComunidadAutonoma("")).toBeNull();
    expect(resolveComunidadAutonoma("   ")).toBeNull();
  });

  // Opus review fix: these official INE co-official "province/province"
  // slash forms appear verbatim in some scraped `property.province` values
  // and previously fell through to the national fallback despite the
  // province itself being perfectly recognizable — normalizeProvince
  // strips diacritics/case but does not split on "/".
  it("resolves official INE slash forms verbatim (not split)", () => {
    expect(resolveComunidadAutonoma("Araba/Álava")).toBe("País Vasco");
    expect(resolveComunidadAutonoma("Alicante/Alacant")).toBe("Comunidad Valenciana");
    expect(resolveComunidadAutonoma("Castellón/Castelló")).toBe("Comunidad Valenciana");
    expect(resolveComunidadAutonoma("Valencia/València")).toBe("Comunidad Valenciana");
  });

  it("resolves Tenerife and Mallorca as bare island names, not just their full province names", () => {
    expect(resolveComunidadAutonoma("Tenerife")).toBe("Canarias");
    expect(resolveComunidadAutonoma("Mallorca")).toBe("Baleares");
  });
});

describe("ITP_RATE_BY_CCAA table integrity", () => {
  it("every province in the lookup table maps to a CCAA that has a rate", () => {
    // Referential-integrity check: a typo in either table (e.g. a province
    // pointing at a CCAA name string that doesn't exactly match a key in
    // ITP_RATE_BY_CCAA) would silently produce `undefined` rates at runtime
    // — catch it here instead of at query time.
    const provinceToCcaa: Record<string, string> = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          [
            "madrid", "barcelona", "malaga", "alicante", "las palmas", "alava",
          ].map((p) => [p, resolveComunidadAutonoma(p)]),
        ),
      ),
    );
    for (const ccaa of Object.values(provinceToCcaa)) {
      expect(ccaa).not.toBeNull();
      expect(ITP_RATE_BY_CCAA[ccaa as string]).toBeGreaterThan(0);
    }
  });

  it("every rate is a plausible percentage (0-100, in practice single digits to low teens)", () => {
    for (const [ccaa, rate] of Object.entries(ITP_RATE_BY_CCAA)) {
      expect(rate, `${ccaa} rate`).toBeGreaterThan(0);
      expect(rate, `${ccaa} rate`).toBeLessThan(20);
    }
  });

  // Opus review must-fix #5: 16 of 19 rates had NO test pinning their exact
  // value — only Andalucía/Cataluña/Madrid were exercised, and the only
  // other guard (the 0-100 plausibility check above) survives essentially
  // any plausible typo. Verified BEFORE this test existed: mutating
  // "Comunidad Valenciana": 9 -> 10 was caught by NEITHER the plausibility
  // check NOR the Andalucía-vs-Madrid comparison test — 34/34 of the
  // then-existing suite passed. This test pins every one of the table's 19
  // entries to its exact, individually-cited value so a single-region
  // typo/mutation can never pass silently again.
  it("pins the exact rate for all 19 CCAA/autonomous-city entries (catches any single-region typo)", () => {
    expect(ITP_RATE_BY_CCAA).toEqual({
      "Andalucía": 7,
      "Aragón": 8,
      "Asturias": 8,
      "Baleares": 8,
      "Canarias": 6.5,
      "Cantabria": 9,
      "Castilla y León": 8,
      "Castilla-La Mancha": 9,
      "Cataluña": 10,
      "Extremadura": 8,
      "Galicia": 8,
      "Madrid": 6,
      "Murcia": 8,
      "Navarra": 6,
      "País Vasco": 4,
      "La Rioja": 7,
      "Comunidad Valenciana": 9,
      "Ceuta": 3,
      "Melilla": 3,
    });
    expect(Object.keys(ITP_RATE_BY_CCAA)).toHaveLength(19);
  });

  // Opus review "Also fix": Ceuta's rate was 6% — double the actual 3% an
  // investor pays once art. 57 bis TRLITPAJD's statutory 50% bonificación
  // is applied. A 2x overstatement of every Ceuta acquisition-cost figure.
  it("applies Ceuta's post-bonificación 3% rate, not the pre-bonus 6%", () => {
    expect(ITP_RATE_BY_CCAA["Ceuta"]).toBe(3);
    const result = computeAcquisitionCosts(200000, "Ceuta");
    expect(result.itp_pct).toBe(3);
    expect(result.itp_eur).toBeCloseTo(6000, 6);
  });
});

describe("computeAcquisitionCosts", () => {
  // Worked example, computed independently by hand:
  //   price = 200,000 €, Madrid (6% ITP)
  //   ITP:      200,000 * 0.06  = 12,000 €
  //   Notary:   200,000 * 0.003 =    600 €
  //   Registry: 200,000 * 0.002 =    400 €
  //   Gestoría:                 =    300 € (flat)
  //   Total:                    = 13,300 €
  //   total_pct_of_price = 13,300 / 200,000 = 0.0665
  it("matches a hand-computed reference case for Madrid", () => {
    const result = computeAcquisitionCosts(200000, "Madrid");
    expect(result.comunidad_autonoma).toBe("Madrid");
    expect(result.province_recognized).toBe(true);
    expect(result.itp_is_override).toBe(false);
    expect(result.itp_pct).toBe(6);
    expect(result.itp_eur).toBeCloseTo(12000, 6);
    expect(result.notary_pct).toBe(DEFAULT_NOTARY_PCT);
    expect(result.notary_eur).toBeCloseTo(600, 6);
    expect(result.registry_pct).toBe(DEFAULT_REGISTRY_PCT);
    expect(result.registry_eur).toBeCloseTo(400, 6);
    expect(result.gestoria_eur).toBe(DEFAULT_GESTORIA_EUR);
    expect(result.total_eur).toBeCloseTo(13300, 6);
    expect(result.total_pct_of_price).toBeCloseTo(0.0665, 6);
  });

  // Mutation check: Andalucía's real, current rate (7%) must differ from
  // Madrid's (6%) — guards against the table collapsing to one flat rate
  // (a real, easy-to-introduce bug: copy-pasting one region's row for all).
  it("applies a materially different ITP rate for a different region (Andalucía vs Madrid)", () => {
    const madrid = computeAcquisitionCosts(300000, "Madrid");
    const andalucia = computeAcquisitionCosts(300000, "Sevilla");
    expect(andalucia.itp_pct).toBe(7);
    expect(madrid.itp_pct).toBe(6);
    expect(andalucia.itp_eur).not.toBeCloseTo(madrid.itp_eur, 0);
    // A 1 percentage-point ITP difference on 300k is a real 3,000€ swing —
    // exactly the "wrong rate silently skews every yield in a region" case
    // issue #151 warns about.
    expect(andalucia.itp_eur - madrid.itp_eur).toBeCloseTo(3000, 6);
  });

  it("falls back to the national default and flags the province as unrecognized when unknown", () => {
    const result = computeAcquisitionCosts(200000, "Nowhereshire");
    expect(result.comunidad_autonoma).toBeNull();
    expect(result.province_recognized).toBe(false);
    expect(result.itp_pct).toBe(NATIONAL_FALLBACK_ITP_PCT);
  });

  it("falls back to the national default when province is null", () => {
    const result = computeAcquisitionCosts(200000, null);
    expect(result.province_recognized).toBe(false);
    expect(result.itp_pct).toBe(NATIONAL_FALLBACK_ITP_PCT);
  });

  it("an itp_pct_override replaces the regional rate entirely and is flagged as an override", () => {
    const result = computeAcquisitionCosts(200000, "Madrid", { itp_pct_override: 4 });
    expect(result.itp_is_override).toBe(true);
    expect(result.itp_pct).toBe(4);
    expect(result.itp_eur).toBeCloseTo(8000, 6);
    // Overriding ITP must not silently mutate the regional table read
    // elsewhere — the comunidad_autonoma label is still reported correctly.
    expect(result.comunidad_autonoma).toBe("Madrid");
  });

  it("notary_pct/registry_pct/gestoria_eur overrides each apply independently", () => {
    const result = computeAcquisitionCosts(100000, "Madrid", {
      notary_pct: 1,
      registry_pct: 0.5,
      gestoria_eur: 500,
    });
    expect(result.notary_eur).toBeCloseTo(1000, 6);
    expect(result.registry_eur).toBeCloseTo(500, 6);
    expect(result.gestoria_eur).toBe(500);
    // ITP unaffected by the other overrides.
    expect(result.itp_pct).toBe(6);
  });

  it("throws on a non-positive purchase price rather than returning a nonsensical negative/zero cost breakdown", () => {
    expect(() => computeAcquisitionCosts(0, "Madrid")).toThrow();
    expect(() => computeAcquisitionCosts(-100, "Madrid")).toThrow();
  });

  it("rates_last_verified is a real (parseable) date, so staleness is checkable", () => {
    const result = computeAcquisitionCosts(200000, "Madrid");
    expect(Number.isNaN(Date.parse(result.rates_last_verified))).toBe(false);
  });
});
