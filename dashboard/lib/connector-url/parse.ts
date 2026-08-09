/**
 * Generic, connector-agnostic URL ↔ params inference for the "Validar filtros"
 * page (issue #491).
 *
 * There is exactly ONE implementation here and ZERO per-connector TypeScript:
 * each connector publishes a declarative {@link SearchUrlGrammar} (build
 * template + ECMAScript-canonical parse regex) to `connector_registry
 * .search_url_grammar` from the Python side (etl.orchestrator
 * .sync_connector_registry), and this module builds/parses URLs from it in the
 * browser. Parity with the Python `SearchUrlGrammar.parse` is guaranteed by a
 * generated fixture both test suites consume
 * (`etl/tests/fixtures/url-grammar-cases.json`), not by two hand-kept
 * implementations agreeing.
 *
 * `parse_pattern` is stored in ECMAScript form (`(?<name>…)`), so `RegExp`
 * consumes it verbatim — no translation on this side (the Python side does the
 * `(?P<name>…)` translation instead).
 */

/** One robots-forbidden URL shape and the message key that explains it (#493). */
export interface RejectReason {
  /** Start-anchored, ECMAScript regex fragment matching the forbidden shape. */
  pattern: string;
  /** Message key the UI maps to a concrete explanation (blocks saving). */
  reason: string;
}

/** A connector's declarative search-URL grammar, camelCased from the JSONB. */
export interface SearchUrlGrammar {
  /** `str.format`-style template with `{placeholder}` slots. */
  buildTemplate: string;
  /** Anchored, ECMAScript-canonical regex; named groups == template slots. */
  parsePattern: string;
  /** Per-placeholder metadata (label, source, consumed) mirroring SearchParam fields. */
  params: Record<string, { label?: string; source?: string; consumed?: boolean }>;
  /**
   * Robots-forbidden shapes this portal serves but discover() could never open
   * (issue #493) — a URL matching one is a HARD, reasoned block, distinct from a
   * plain no-match (kept verbatim). Empty for connectors with no such bans.
   */
  rejectReasons: RejectReason[];
}

/**
 * Defensively parse a raw JSONB grammar (snake_case, as Python's
 * `dataclasses.asdict` serialises it — the shape stored in the registry column
 * AND in the parity fixture) into a typed, camelCased {@link SearchUrlGrammar}.
 * Returns null when the value is absent or structurally invalid, so the caller
 * degrades to "no live inference" rather than throwing.
 */
export function parseGrammar(raw: unknown): SearchUrlGrammar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const buildTemplate = r.build_template;
  const parsePattern = r.parse_pattern;
  if (typeof buildTemplate !== "string" || typeof parsePattern !== "string") return null;
  const params: SearchUrlGrammar["params"] = {};
  if (typeof r.params === "object" && r.params !== null) {
    for (const [key, meta] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof meta === "object" && meta !== null) {
        const m = meta as Record<string, unknown>;
        params[key] = {
          label: typeof m.label === "string" ? m.label : undefined,
          source: typeof m.source === "string" ? m.source : undefined,
          // Only an explicit `false` marks a param the connector doesn't act on
          // (issue #494/#495); absent → consumed (undefined, treated as true).
          consumed: typeof m.consumed === "boolean" ? m.consumed : undefined,
        };
      } else {
        params[key] = {};
      }
    }
  }
  const rejectReasons: RejectReason[] = [];
  if (Array.isArray(r.reject_reasons)) {
    for (const entry of r.reject_reasons) {
      if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>;
        if (typeof e.pattern === "string" && typeof e.reason === "string") {
          rejectReasons.push({ pattern: e.pattern, reason: e.reason });
        }
      }
    }
  }
  return { buildTemplate, parsePattern, params, rejectReasons };
}

/**
 * Infer the parameters a URL encodes under `grammar`, or null when the URL
 * doesn't match the grammar (an owner-edited URL the grammar can't invert — the
 * page then keeps it verbatim with a warning). Mirrors Python
 * `SearchUrlGrammar.parse`.
 */
export function inferParams(
  grammar: SearchUrlGrammar,
  url: string,
): Record<string, string> | null {
  let re: RegExp;
  try {
    re = new RegExp(grammar.parsePattern);
  } catch {
    // A malformed published pattern must not crash the page — treat it as
    // "cannot infer", same as a non-matching URL.
    return null;
  }
  const match = re.exec(url);
  if (match === null || match.groups === undefined) return null;
  // RegExp named groups come back as a null-prototype object; copy to a plain
  // one and drop any group that didn't participate (undefined).
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(match.groups)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Build a URL from `params` under `grammar` (fills each `{placeholder}` slot;
 * an absent key becomes empty). Mirrors Python `SearchUrlGrammar.build`.
 */
export function buildUrl(grammar: SearchUrlGrammar, params: Record<string, string>): string {
  return grammar.buildTemplate.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? params[key] : "",
  );
}

/**
 * The reject-reason KEY of the first {@link SearchUrlGrammar.rejectReasons}
 * pattern that matches `url`, or null (issue #493). Mirrors Python
 * `SearchUrlGrammar.rejection`.
 *
 * A rejected URL is one this portal serves but discover() could never open (a
 * robots.txt-forbidden shape) — the caller must BLOCK saving it with the reason,
 * distinct from a plain no-match (`inferParams` → null → kept verbatim).
 * Rejection takes precedence over parsing: a URL that both parses and is
 * rejected is still rejected (e.g. a bare-geography slug). Patterns are stored
 * ECMAScript-canonical, so `RegExp` consumes them verbatim (no translation).
 */
export function rejection(grammar: SearchUrlGrammar, url: string): string | null {
  // Tolerate a grammar shaped without rejectReasons (older stored rows, or a
  // hand-built test fixture) — treat it as "no reject reasons".
  for (const { pattern, reason } of grammar.rejectReasons ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      // A malformed published reject pattern must not crash the page — skip it.
      continue;
    }
    if (re.test(url)) return reason;
  }
  return null;
}
