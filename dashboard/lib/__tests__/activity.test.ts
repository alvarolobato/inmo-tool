// @vitest-environment node
/**
 * Unit tests for the PURE half of Actividad (issue #644, `lib/activity.ts`):
 * the metric chips, the per-day rollup, the "not measured is not zero" rule
 * and the Madrid-local day helpers. The SQL half has its own real-Postgres
 * test (`lib/db/__tests__/activity.integration.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  formatCount,
  formatMs,
  formatWhen,
  formatDayHeading,
  madridDay,
  metricsFor,
  shiftDay,
  msPer,
  rollupDay,
  matchesFilter,
  sourcesIn,
  ACTIVITY_KINDS,
  KIND_GLYPH,
  KIND_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  FAILURE_CLASS_LABELS,
  failureClassLabel,
  failureClassSeverity,
} from "../activity";
import type { ActivityEvent, ActivityKind } from "../activity";

function ev(over: Partial<ActivityEvent> & { kind: ActivityKind }): ActivityEvent {
  return {
    id: `${over.kind}:1`,
    source: "fotocasa",
    t: "2026-03-05T10:00:00.000Z",
    tEnd: null,
    status: "ok",
    counts: {},
    note: null,
    codes: [],
    detailHref: null,
    rolledUp: 1,
    ...over,
  };
}

describe("formatting — not measured is not zero (D-162)", () => {
  it("renders null as an em dash, never 0", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(0)).toBe("0");
    expect(formatMs(null)).toBe("—");
  });

  it("refuses to divide by a zero denominator", () => {
    expect(msPer(1000, 0)).toBeNull();
    expect(msPer(null, 10)).toBeNull();
    expect(msPer(1000, 0)).toBeNull();
    expect(msPer(2000, 4)).toBe(500);
  });

  it("renders a session range only when the two ends differ at minute resolution", () => {
    // A 40-second "session" must not read "11:04–11:04", which would imply a
    // duration that is not there.
    expect(formatWhen("2026-03-05T10:04:00Z", "2026-03-05T10:04:40Z")).not.toContain("–");
    expect(formatWhen("2026-03-05T10:04:00Z", "2026-03-05T11:40:00Z")).toContain("–");
    expect(formatWhen("2026-03-05T10:04:00Z", null)).not.toContain("–");
  });
});

describe("Madrid-local days", () => {
  it("buckets by the owner's clock, not UTC", () => {
    // 23:30Z on 5 March is 00:30 on 6 March in Madrid (CET, UTC+1).
    expect(madridDay(new Date("2026-03-05T23:30:00Z"))).toBe("2026-03-06");
    expect(madridDay(new Date("2026-03-05T22:30:00Z"))).toBe("2026-03-05");
    // ...and in CEST (UTC+2) the boundary moves with the offset.
    expect(madridDay(new Date("2026-08-21T22:30:00Z"))).toBe("2026-08-22");
  });

  it("shifts a day key without a DST-induced off-by-one", () => {
    // 2026-03-29 is the CET→CEST switch in Madrid. Anchoring the arithmetic
    // at midnight would land on 23:00 the previous day here.
    expect(shiftDay("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDay("2026-03-30", -1)).toBe("2026-03-29");
    // ...and the CEST→CET switch in October.
    expect(shiftDay("2026-10-25", -1)).toBe("2026-10-24");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("labels today and yesterday relatively, older days by date", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    expect(formatDayHeading("2026-03-05", now)).toBe("Hoy");
    expect(formatDayHeading("2026-03-04", now)).toBe("Ayer");
    expect(formatDayHeading("2026-03-01", now)).toMatch(/mar/);
  });
});

describe("metricsFor — one vocabulary, no per-kind prose", () => {
  it("gives every kind at least one metric and no empty values", () => {
    for (const kind of ACTIVITY_KINDS) {
      const metrics = metricsFor(ev({ kind }));
      expect(metrics.length, kind).toBeGreaterThan(0);
      for (const m of metrics) {
        expect(m.label.trim().length, `${kind}/${m.label}`).toBeGreaterThan(0);
        expect(m.value.trim().length, `${kind}/${m.label}`).toBeGreaterThan(0);
      }
    }
  });

  it("crawl shows the ingest funnel, and the verification pair only when it ran", () => {
    const quiet = metricsFor(
      ev({ kind: "crawl", counts: { discovered: 15, fetched: 4, errors: 0, verified: null } }),
    );
    expect(quiet[0].value).toBe("15 → 4");
    expect(quiet.some((m) => m.label.startsWith("Verificados"))).toBe(false);

    const verified = metricsFor(
      ev({ kind: "crawl", counts: { discovered: 179, fetched: 10, verified: 10, gone: 4 } }),
    );
    expect(verified.find((m) => m.label.startsWith("Verificados"))!.value).toBe("10 → 4");
  });

  it("crawl only claims a per-listing work figure when both legs are measured", () => {
    const unmeasured = metricsFor(ev({ kind: "crawl", counts: { fetched: 4, fetchMsTotal: null } }));
    expect(unmeasured.some((m) => m.label === "Trabajo/anuncio")).toBe(false);
    const measured = metricsFor(ev({ kind: "crawl", counts: { fetched: 4, fetchMsTotal: 4000 } }));
    expect(measured.find((m) => m.label === "Trabajo/anuncio")!.value).toBe("1.0 s");
  });

  it("a capture session claims a render-wait median only for rows that carry one", () => {
    const untimed = metricsFor(
      ev({ kind: "captura", counts: { total: 1142, done: 1142, timed: 0, renderWaitMsP50: null } }),
    );
    expect(untimed.some((m) => m.label.startsWith("Espera de render"))).toBe(false);
    const timed = metricsFor(
      ev({ kind: "captura", counts: { total: 15, done: 15, timed: 15, renderWaitMsP50: 1500 } }),
    );
    expect(timed.find((m) => m.label.startsWith("Espera de render"))!.value).toBe("1.5 s");
  });

  it("a withdrawal always states how much of it is evidence-backed (D-157)", () => {
    const m = metricsFor(
      ev({ kind: "estado", note: "withdrawn", counts: { rows: 25, withEvidence: 0 } }),
    );
    expect(m[0].label).toBe("Retiradas");
    expect(m[0].value).toBe("25");
    expect(m.find((x) => x.label === "Con evidencia")!.value).toBe("0 / 25");
  });

  it("a resurrection is labelled as one, and is not asked for evidence", () => {
    const m = metricsFor(ev({ kind: "estado", note: "reactivated", counts: { rows: 3 } }));
    expect(m[0].label).toBe("Reactivadas");
    expect(m.some((x) => x.label === "Con evidencia")).toBe(false);
  });
});

describe("rollupDay — the answer to '¿cuántos datos se han cargado?'", () => {
  it("sums BOTH ingest paths, which the run-centric monitor could not", () => {
    const roll = rollupDay([
      ev({ kind: "crawl", counts: { fetched: 10, errors: 2 } }),
      ev({ kind: "crawl", counts: { fetched: 584, errors: 16 } }),
      ev({ kind: "captura", counts: { total: 1350, done: 1338, failed: 1 } }),
      ev({ kind: "estado", note: "withdrawn", counts: { rows: 4 } }),
      ev({ kind: "estado", note: "reactivated", counts: { rows: 9 } }),
      ev({ kind: "dedup", status: "curso", counts: {} }),
    ]);
    expect(roll.guardados).toBe(10 + 584 + 1338);
    expect(roll.capturas).toBe(1350);
    // Reactivations are not retirements.
    expect(roll.retiradas).toBe(4);
    expect(roll.errores).toBe(2 + 16 + 1);
    expect(roll.enCurso).toBe(1);
    expect(roll.eventos).toBe(6);
  });

  it("treats a missing count as missing, not as zero contribution ambiguity", () => {
    const roll = rollupDay([ev({ kind: "crawl", counts: { fetched: null, errors: null } })]);
    expect(roll.guardados).toBe(0);
    expect(roll.errores).toBe(0);
  });
});

describe("filters", () => {
  const events = [
    ev({ kind: "crawl", source: "fotocasa" }),
    ev({ kind: "captura", source: "idealista" }),
    ev({ kind: "dedup", source: null }),
  ];

  it("kind filter is a union; empty means everything", () => {
    expect(events.filter((e) => matchesFilter(e, { kinds: [], source: null }))).toHaveLength(3);
    expect(
      events.filter((e) => matchesFilter(e, { kinds: ["crawl", "dedup"], source: null })),
    ).toHaveLength(2);
  });

  it("source filter never silently keeps the sourceless pipeline events", () => {
    const kept = events.filter((e) => matchesFilter(e, { kinds: [], source: "fotocasa" }));
    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe("crawl");
  });

  it("sourcesIn lists every distinct source, sorted, nulls dropped", () => {
    expect(sourcesIn([{ day: "2026-03-05", events }])).toEqual(["fotocasa", "idealista"]);
  });
});

describe("typed failure kinds — one copy of the vocabulary", () => {
  it("labels the closed enum and passes unknown values through untouched", () => {
    expect(failureClassLabel("soft_block")).toBe("Bloqueo temporal");
    // A future taxonomy value must be SHOWN, never swallowed into "Otro".
    expect(failureClassLabel("captcha_wall")).toBe("captcha_wall");
    // ...and so must a free-text code that is not a failure class at all
    // (a requeue reason, a block signature) — the feed renders these through
    // the same helper.
    expect(failureClassLabel("ratio 8/10 >= 80%")).toBe("ratio 8/10 >= 80%");
  });

  it("keeps D-079's severity ranking: a soft block is not a break", () => {
    expect(failureClassSeverity("soft_block")).toBe("warn");
    expect(failureClassSeverity("empty_result")).toBe("warn");
    expect(failureClassSeverity("uncovered")).toBe("neutral");
    expect(failureClassSeverity("unresolvable")).toBe("neutral");
    expect(failureClassSeverity("structure_change")).toBe("bad");
    expect(failureClassSeverity("network")).toBe("bad");
  });

  it("RunDetail.tsx does not keep a second copy of the label map", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const runDetail = readFileSync(
      resolve(here, "..", "..", "components", "etl", "RunDetail.tsx"),
      "utf8",
    );
    expect(runDetail).toContain('from "@/lib/activity"');
    expect(runDetail).toContain("failureClassLabel");
    expect(runDetail).not.toContain("FAILURE_CLASS_LABELS");
    // (`GEO_OUTCOME_LABELS` in that file legitimately reuses one of the same
    // strings for a DIFFERENT enum — per-geography outcomes, D-079 #109 — so
    // this checks the map, not the words.)
    // Every enum member is still reachable from the one place that has them.
    expect(Object.keys(FAILURE_CLASS_LABELS).sort()).toEqual([
      "empty_result",
      "network",
      "other",
      "soft_block",
      "structure_change",
      "uncovered",
      "unresolvable",
    ]);
  });
});

describe("the vocabulary is complete", () => {
  it("every kind has a label and a glyph, and every status a label and a colour", () => {
    for (const k of ACTIVITY_KINDS) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_GLYPH[k]).toBeTruthy();
    }
    for (const s of ["ok", "aviso", "error", "curso", "omitido"] as const) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
