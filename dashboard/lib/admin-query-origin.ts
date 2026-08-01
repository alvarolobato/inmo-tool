/**
 * Origin matcher for pg_stat_statements slow queries.
 *
 * Given the raw SQL text from pg_stat_statements, attempts to identify
 * where in the codebase the query was generated.  Matching is done by
 * extracting a "fingerprint" (set of ps_* tokens) from both the candidate
 * and the source SQL, then finding the best match by Jaccard similarity.
 *
 * Priority order:
 *   1. dashboard/lib/templates/*.ts  (template widget SQL)
 *   2. Saved dashboards from the database (widget SQL in the spec JSON)
 *   3. dashboard/lib/review-queries.ts (REVIEW_QUERIES array)
 *   4. dashboard/lib/knowledge.ts     (SQL_PAIRS — typed copy of wren SQL pairs)
 *
 * Returns null when no source reaches the minimum similarity threshold.
 */

import { TEMPLATES } from "@/lib/templates";
import { REVIEW_QUERIES } from "@/lib/review-queries";
import { SQL_PAIRS } from "@/lib/knowledge";
import type { DashboardSpec } from "@/lib/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryOrigin {
  /** Human-readable source label, e.g. "Template: Responsable de Ventas > Ventas Netas" */
  source: string;
  /** Relative file path hint when deterministic, e.g. "dashboard/lib/templates/ventas.ts" */
  locationHint?: string;
}

// ─── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Extract a normalised fingerprint from a SQL string.
 *
 * Matches all `ps_*` tokens anywhere in the SQL (table names as well as
 * references in SELECT lists, aliases, etc.).  While this can include some
 * false positives, it is intentionally broad so that joined tables captured
 * in `pg_stat_statements` output still produce a useful overlap signal.
 *
 * Returns a sorted, deduplicated array.  An empty array means "no ps_* tokens
 * found" — origin matching should be skipped for such queries.
 */
export function extractSqlFingerprint(sql: string): string[] {
  if (!sql) return [];
  const matches = sql.toLowerCase().match(/\bps_[a-z_]+/g) ?? [];
  return [...new Set(matches)].sort();
}

/**
 * Jaccard similarity between two fingerprint arrays.
 * Returns a number in [0, 1].  Returns 0 when both are empty.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Minimum Jaccard similarity to claim a match. */
const MIN_SIMILARITY = 0.5;

// ─── Source candidates ────────────────────────────────────────────────────────

interface Candidate {
  source: string;
  locationHint?: string;
  fingerprint: string[];
}

/**
 * Lazily-built candidate list from static sources (templates + review queries +
 * knowledge SQL pairs).  Built once and cached at module scope — these never
 * change at runtime.
 */
let _staticCandidates: Candidate[] | null = null;

function buildStaticCandidates(): Candidate[] {
  const results: Candidate[] = [];

  // ── Templates ──────────────────────────────────────────────────────────────
  for (const tmpl of TEMPLATES) {
    const spec = tmpl.spec;
    const locationHint = `dashboard/lib/templates/${tmpl.slug}.ts`;
    for (const widget of spec.widgets) {
      const sqls: string[] = [];
      if ("sql" in widget && typeof widget.sql === "string") {
        sqls.push(widget.sql);
      }
      if ("items" in widget && Array.isArray(widget.items)) {
        for (const item of widget.items) {
          if (item && typeof item === "object" && "sql" in item && typeof item.sql === "string") {
            sqls.push(item.sql);
          }
        }
      }
      for (const sql of sqls) {
        const fp = extractSqlFingerprint(sql);
        if (fp.length > 0) {
          const widgetLabel =
            "title" in widget && widget.title
              ? String(widget.title)
              : "items" in widget
              ? "kpi_row"
              : widget.type ?? "widget";
          results.push({
            source: `Template: ${tmpl.name} > ${widgetLabel}`,
            locationHint,
            fingerprint: fp,
          });
        }
      }
    }
  }

  // ── Review queries ─────────────────────────────────────────────────────────
  for (const q of REVIEW_QUERIES) {
    const fp = extractSqlFingerprint(q.sql);
    if (fp.length > 0) {
      results.push({
        source: `Review: ${q.name} (${q.domain})`,
        locationHint: "dashboard/lib/review-queries.ts",
        fingerprint: fp,
      });
    }
  }

  // ── Knowledge SQL pairs (typed copy of wren-push-metadata.py SQL_PAIRS) ───
  for (const pair of SQL_PAIRS) {
    const fp = extractSqlFingerprint(pair.sql);
    if (fp.length > 0) {
      results.push({
        source: `WrenAI SQL pair: ${pair.question.slice(0, 60)}`,
        locationHint: "dashboard/lib/knowledge.ts",
        fingerprint: fp,
      });
    }
  }

  return results;
}

function getStaticCandidates(): Candidate[] {
  if (_staticCandidates === null) {
    _staticCandidates = buildStaticCandidates();
  }
  return _staticCandidates;
}

/** Extract SQL strings from a raw dashboard spec JSON. */
function extractSpecSqls(specJson: unknown): string[] {
  const sqls: string[] = [];
  if (!specJson || typeof specJson !== "object") return sqls;
  const spec = specJson as DashboardSpec;
  if (!Array.isArray(spec.widgets)) return sqls;
  for (const widget of spec.widgets) {
    if ("sql" in widget && typeof widget.sql === "string") sqls.push(widget.sql);
    if ("items" in widget && Array.isArray(widget.items)) {
      for (const item of widget.items) {
        if (item && typeof item === "object" && "sql" in item && typeof item.sql === "string") {
          sqls.push(item.sql);
        }
      }
    }
  }
  return sqls;
}

/** Build candidates from saved dashboards (injected to avoid DB coupling in tests). */
export function savedDashboardCandidates(
  dashboards: Array<{ id: string; title?: string; spec: unknown }>,
): Candidate[] {
  const results: Candidate[] = [];
  for (const db of dashboards) {
    const sqls = extractSpecSqls(db.spec);
    for (const sql of sqls) {
      const fp = extractSqlFingerprint(sql);
      if (fp.length > 0) {
        results.push({
          source: `Dashboard guardado: ${db.title ?? db.id}`,
          fingerprint: fp,
        });
      }
    }
  }
  return results;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface FindQueryOriginOptions {
  /** Pre-built saved dashboard candidates (compute once per request, pass per row). */
  savedDashboardCandidateList?: Candidate[];
}

/**
 * Find the most likely origin of a pg_stat_statements SQL string.
 *
 * Uses pre-cached static candidates (templates + review queries + knowledge SQL pairs)
 * for O(1) per-request candidate building, plus optional per-request dashboard
 * candidates passed in from the call site.
 *
 * Returns null when no source reaches MIN_SIMILARITY threshold or when the
 * query fingerprint is empty (e.g. a DDL or a non-ps_* query).
 */
export function findQueryOrigin(
  rawSql: string,
  options: FindQueryOriginOptions = {},
): QueryOrigin | null {
  const target = extractSqlFingerprint(rawSql);
  if (target.length === 0) return null;

  // Static candidates are cached at module scope (built once)
  const staticCandidates = getStaticCandidates();
  const dashboardCandidates = options.savedDashboardCandidateList ?? [];

  let bestSim = 0;
  let bestCandidate: Candidate | null = null;

  for (const candidate of staticCandidates) {
    const sim = jaccardSimilarity(target, candidate.fingerprint);
    if (sim > bestSim) {
      bestSim = sim;
      bestCandidate = candidate;
    }
  }

  // Dashboard candidates come after static ones (lower priority)
  for (const candidate of dashboardCandidates) {
    const sim = jaccardSimilarity(target, candidate.fingerprint);
    if (sim > bestSim) {
      bestSim = sim;
      bestCandidate = candidate;
    }
  }

  if (bestSim < MIN_SIMILARITY || bestCandidate === null) return null;

  return {
    source: bestCandidate.source,
    locationHint: bestCandidate.locationHint,
  };
}

// Re-export for test use
export type { Candidate };
