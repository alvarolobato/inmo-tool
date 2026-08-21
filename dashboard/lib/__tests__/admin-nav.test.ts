// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ADMIN_NAV, activeAdminHref, type AdminNavItem } from "../admin-nav";

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

  it("contains the renamed + consolidated entries and drops the deleted LLM tabs (#653)", () => {
    const byHref = new Map(ADMIN_NAV.map((i) => [i.href, i]));

    // Renames.
    expect(byHref.get("/admin/clasificacion")?.label).toBe("Clasificación");
    // #642 P1: "Conectores" + "Captura (admin)" merged into "Fuentes".
    expect(byHref.get("/admin/fuentes")?.label).toBe("Fuentes");

    // Duplicados now on the strip.
    expect(byHref.get("/admin/dedup")?.label).toBe("Duplicados");

    // Old / deleted routes are gone from the nav: the #508 candidatos stub
    // (deleted outright by #653), the two 0-row LLM surfaces (deleted
    // outright), the standalone slow-queries page (folded into /admin/llm),
    // the captured-urls dev decode page (deleted outright), and the two
    // merged-into-Fuentes tabs (#642 P1 — both routes still resolve, via a
    // 301, just off the nav strip).
    for (const href of [
      "/admin/candidatos",
      "/admin/interactions",
      "/admin/tool-calls",
      "/admin/slow-queries",
      "/admin/captured-urls",
      "/etl/connectors",
      "/etl/captura",
    ]) {
      expect(byHref.has(href)).toBe(false);
    }

    // The consolidated LLM page also owns /admin/usage (a permanent redirect
    // — its data, llm_usage, is live, unlike the deleted surfaces above).
    const llm = byHref.get("/admin/llm");
    expect(llm?.label).toBe("LLM");
    expect(llm?.matchPrefixes).toEqual(["/admin/usage"]);
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
    // #642 P1: /etl/connectors and /etl/captura are deleted outright (no
    // page.tsx — a config-level 301 to Fuentes in next.config.js, so these
    // pathnames are never actually rendered in practice) — no nav item of
    // their OWN owns them any more. `activeAdminHref` is pure string
    // matching though, so as sub-paths of `/etl` they now fall through to
    // Monitor ETL's own prefix, same longest-prefix logic that used to give
    // /etl/connectors its own nav item precedence over Monitor ETL. A
    // deeper /admin/fuentes/* route DOES light up Fuentes (the new
    // per-source detail page).
    ["/etl/connectors", "/etl"],
    ["/admin/fuentes", "/admin/fuentes"],
    ["/admin/fuentes/fotocasa", "/admin/fuentes"],
    ["/etl/captura", "/etl"],
    ["/admin/clasificacion", "/admin/clasificacion"],
    ["/admin/dedup", "/admin/dedup"],
    // /admin/usage (a permanent redirect to /admin/llm) highlights the LLM
    // tab too. The other three ex-sub-routes are deleted (#653) — no nav item
    // owns them any more, so they highlight nothing.
    ["/admin/llm", "/admin/llm"],
    ["/admin/usage", "/admin/llm"],
    ["/admin/slow-queries", null],
    ["/admin/tool-calls", null],
    ["/admin/interactions", null],
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
