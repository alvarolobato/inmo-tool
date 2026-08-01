/**
 * Compile dashboard global filter tokens in widget SQL into PostgreSQL
 * parameterized fragments ($1, $2, …) plus a matching params array.
 *
 * Widget and options SQL may contain tokens `__gf_<id>__` (see schema docs).
 * Date-range tokens (:curr_from, etc.) must already be substituted before
 * calling this module.
 */

import type { DashboardSpec, GlobalFilter } from "./schema";

/** Active values keyed by global filter `id`. */
export type GlobalFilterScalar = string | number;
export type GlobalFilterValues = Record<
  string,
  GlobalFilterScalar | GlobalFilterScalar[]
>;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function coalesceNumericScalar(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);
}

function isNonEmptyNumberArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function tokenForFilterId(id: string): string {
  return `__gf_${id}__`;
}

function pgScalarCast(filter: GlobalFilter): "text" | "numeric" {
  return filter.value_type === "numeric" ? "numeric" : "text";
}

function pgArrayCast(filter: GlobalFilter): "text[]" | "numeric[]" {
  return filter.value_type === "numeric" ? "numeric[]" : "text[]";
}

export interface CompileGlobalFiltersOptions {
  /** When set, the filter with this id is always neutralized to TRUE (for option lists). */
  excludeFilterId?: string;
}

/**
 * Replace every `__gf_<id>__` token in `sql` using `spec.filters` and `values`.
 * Returns parameterized SQL suitable for `query(sql, params)`.
 */
export function compileGlobalFilterSql(
  sql: string,
  filters: DashboardSpec["filters"],
  values: GlobalFilterValues,
  options?: CompileGlobalFiltersOptions,
): { sql: string; params: unknown[] } {
  const defs = filters ?? [];
  const params: unknown[] = [];
  let out = sql;

  for (const filter of defs) {
    const token = tokenForFilterId(filter.id);
    if (!out.includes(token)) continue;

    if (options?.excludeFilterId === filter.id) {
      out = out.replaceAll(token, "TRUE");
      continue;
    }

    const raw = values[filter.id];

    if (filter.type === "single_select") {
      const castKind = pgScalarCast(filter);
      const scalar =
        castKind === "numeric" ? coalesceNumericScalar(raw) : isNonEmptyString(raw) ? raw.trim() : null;
      if (scalar === null) {
        out = out.replaceAll(token, "TRUE");
        continue;
      }
      const idx = params.length + 1;
      const cast = castKind;
      params.push(scalar);
      const fragment = `((${filter.bind_expr}) = $${idx}::${cast})`;
      out = out.replaceAll(token, fragment);
      continue;
    }

    // multi_select
    const useNumeric = filter.value_type === "numeric";
    const arrOk = useNumeric ? isNonEmptyNumberArray(raw) : isNonEmptyStringArray(raw);
    if (!arrOk) {
      out = out.replaceAll(token, "TRUE");
      continue;
    }
    const idx = params.length + 1;
    const cast = pgArrayCast(filter);
    params.push(raw);
    const fragment = `((${filter.bind_expr}) = ANY($${idx}::${cast}))`;
    out = out.replaceAll(token, fragment);
  }

  return { sql: out, params };
}

/** Regex that matches any `__gf_<id>__` token with a sane id slug. */
const GF_TOKEN_RE = /__gf_([a-z][a-z0-9_]*)__/g;

/**
 * Return sorted unique global filter ids referenced by a SQL string.
 */
export function listReferencedGlobalFilterIds(sql: string): string[] {
  const ids = new Set<string>();
  for (const m of sql.matchAll(GF_TOKEN_RE)) {
    ids.add(m[1]);
  }
  return Array.from(ids).sort();
}
