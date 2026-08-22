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

    // #642 P1: "Conectores" + "Captura (admin)" merged into "Fuentes", which
    // #642 P2 also made the owner of the two off-strip capture deep links.
    const fuentes = byHref.get("/admin/fuentes");
    expect(fuentes?.label).toBe("Fuentes");
    expect(fuentes?.matchPrefixes).toEqual(["/admin/diagnostics", "/admin/extension"]);

    // #642 P2: Duplicados + Clasificación are ONE "Revisión" tab, landing on
    // the dedup queue; `<RevisionTabs/>` switches between the two queues.
    const revision = byHref.get("/admin/dedup");
    expect(revision?.label).toBe("Revisión");
    expect(revision?.matchPrefixes).toEqual(["/admin/clasificacion"]);
    expect(byHref.has("/admin/clasificacion")).toBe(false);

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
      // #642 P2 deleted the rest of the tree.
      "/etl",
      "/etl/salud",
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
    expect(byHref.has("/admin/extension")).toBe(false);
    expect(byHref.has("/etl/discovery")).toBe(false);
    // Diagnósticos (#671) is off-strip too, owned by Fuentes — see above.
    expect(byHref.has("/admin/diagnostics")).toBe(false);
  });

  // The #636 end state, in order. This list is the strip's contract with the
  // issue; `e2e/admin-nav.spec.ts` asserts the same six against the rendered
  // DOM. Both exist because one is fast and one is real.
  it("is exactly the six sections #636 specified, in order", () => {
    expect(ADMIN_NAV.map((i) => i.label)).toEqual([
      "Estado",
      "Fuentes",
      "Actividad",
      "Revisión",
      "LLM",
      "Configuración",
    ]);
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
    // Estado owns a BARE /admin only. `/admin` is a prefix of every other
    // admin route, so this pair is the one that proves longest-prefix is
    // doing the work — without it, Estado would swallow the whole strip.
    ["/admin", "/admin"],
    ["/admin/fuentes", "/admin/fuentes"],
    ["/admin/fuentes/fotocasa", "/admin/fuentes"],
    // Off-strip deep links Fuentes owns (#642 P2).
    ["/admin/diagnostics", "/admin/fuentes"],
    ["/admin/extension", "/admin/fuentes"],
    ["/admin/actividad", "/admin/actividad"],
    // The run drill-down moved from /etl/[id] to a child of Actividad (#642
    // P2) precisely so it keeps the tab it was reached from highlighted.
    ["/admin/actividad/run/7", "/admin/actividad"],
    // Revisión: one tab, two queues.
    ["/admin/dedup", "/admin/dedup"],
    ["/admin/clasificacion", "/admin/dedup"],
    // /admin/usage (a permanent redirect to /admin/llm) highlights the LLM
    // tab too. The other three ex-sub-routes were deleted outright by #653
    // and 404; since #642 P2 gave Estado the bare `/admin` prefix they fall
    // back to it rather than to nothing. That fallback is deliberate and
    // harmless — a 404 page still renders the strip, and pointing at the
    // landing is a better answer there than highlighting no tab at all.
    ["/admin/llm", "/admin/llm"],
    ["/admin/usage", "/admin/llm"],
    ["/admin/slow-queries", "/admin"],
    ["/admin/tool-calls", "/admin"],
    ["/admin/interactions", "/admin"],
    ["/admin/config", "/admin/config"],
    // #642 P2 deleted every page under /etl, so nothing under it renders a
    // layout and nothing can highlight a tab. These now match nothing, which
    // is the honest answer for a path that 308s before it reaches a layout.
    ["/etl", null],
    ["/etl/salud", null],
    ["/etl/connectors", null],
    ["/etl/captura", null],
    ["/etl/42", null],
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

  it("every matchPrefix resolves to its own item, not to a shorter one", () => {
    for (const item of ADMIN_NAV as AdminNavItem[]) {
      for (const prefix of item.matchPrefixes ?? []) {
        expect(activeAdminHref(prefix), prefix).toBe(item.href);
      }
    }
  });
});
