// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ADMIN_NAV,
  ADMIN_LLM_SUBPAGES,
  activeAdminHref,
  type AdminNavItem,
} from "../admin-nav";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(dashboardRoot, rel), "utf8");
}

describe("ADMIN_NAV — shared nav source (#508)", () => {
  it("has unique hrefs and non-empty labels/descriptions", () => {
    const hrefs = ADMIN_NAV.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of ADMIN_NAV) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains the renamed + consolidated entries and drops the four LLM tabs", () => {
    const byHref = new Map(ADMIN_NAV.map((i) => [i.href, i]));

    // Renames.
    expect(byHref.get("/admin/clasificacion")?.label).toBe("Clasificación");
    expect(byHref.get("/etl/captura")?.label).toBe("Captura (admin)");

    // Duplicados now on the strip.
    expect(byHref.get("/admin/dedup")?.label).toBe("Duplicados");

    // Old names/routes are gone from the nav.
    expect(byHref.has("/admin/candidatos")).toBe(false);
    for (const sub of ADMIN_LLM_SUBPAGES) {
      expect(byHref.has(sub.href)).toBe(false);
    }

    // The four LLM tabs are folded under a single landing.
    const llm = byHref.get("/admin/llm");
    expect(llm?.label).toBe("LLM");
    expect(llm?.matchPrefixes).toEqual(ADMIN_LLM_SUBPAGES.map((s) => s.href));
  });

  it("has removed the Extensión (#509) and Descubrimiento (#511) tabs", () => {
    const byHref = new Map(ADMIN_NAV.map((i) => [i.href, i]));
    expect(byHref.has("/etl/extension")).toBe(false);
    expect(byHref.has("/etl/discovery")).toBe(false);
  });

  it("the nav strip (AdminChrome) renders from ADMIN_NAV, with no local array", () => {
    const chrome = read("app/admin/AdminChrome.tsx");
    expect(chrome).toContain("ADMIN_NAV");
    expect(chrome).toContain("@/lib/admin-nav");
    expect(chrome).not.toContain("const ADMIN_NAV = [");
  });

  // Issue #638: /admin's own content stopped being a second ADMIN_NAV-driven
  // card grid — it is now the Estado board (lib/db/source-health.ts), with
  // navigation between admin surfaces owned entirely by AdminChrome's strip
  // (rendered on every /admin/* route, this one included — see
  // app/admin/layout.tsx). This test only guards against a NEW local nav
  // array reappearing on the index, not against ADMIN_NAV being unused here.
  it("app/admin/page.tsx (Estado board) does not reintroduce a local nav array", () => {
    const index = read("app/admin/page.tsx");
    expect(index).not.toContain("ADMIN_LINKS");
    expect(index).not.toContain("const ADMIN_NAV = [");
  });
});

describe("activeAdminHref — longest-prefix match", () => {
  const cases: Array<[string, string | null]> = [
    ["/etl", "/etl"],
    // A deeper /etl/* route must NOT also light up Monitor ETL.
    ["/etl/connectors", "/etl/connectors"],
    ["/etl/connectors/fotocasa", "/etl/connectors"],
    ["/etl/captura", "/etl/captura"],
    ["/admin/clasificacion", "/admin/clasificacion"],
    ["/admin/dedup", "/admin/dedup"],
    // The four LLM sub-routes all highlight the single LLM tab.
    ["/admin/llm", "/admin/llm"],
    ["/admin/slow-queries", "/admin/llm"],
    ["/admin/tool-calls", "/admin/llm"],
    ["/admin/usage", "/admin/llm"],
    ["/admin/interactions", "/admin/llm"],
    ["/admin/config", "/admin/config"],
    ["/something-else", null],
  ];
  for (const [pathname, expected] of cases) {
    it(`${pathname} → ${expected}`, () => {
      expect(activeAdminHref(pathname)).toBe(expected);
    });
  }

  it("exactly one nav item is active for every nav route (no double-highlight)", () => {
    for (const item of ADMIN_NAV as AdminNavItem[]) {
      const active = activeAdminHref(item.href);
      expect(active).toBe(item.href);
    }
  });
});
