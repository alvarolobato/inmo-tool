/**
 * SQL formatter for pg_stat_statements output.
 *
 * pg_stat_statements collapses whitespace and replaces literals with $N, so
 * adjacent keywords merge: `SELECTCOUNT(*)AS`, `ISNOTNULLGROUPBY`, etc.
 *
 * Strategy:
 *   1. Pre-process: insert spaces between fused keyword tokens so that
 *      sql-formatter can tokenise the query correctly.
 *   2. Format with sql-formatter (postgresql dialect).
 *   3. On failure fall back to the pre-processed string (already more readable
 *      than the raw pg_stat_statements output).
 */

import { format } from "sql-formatter";

const SQL_FORMATTER_OPTIONS = {
  language: "postgresql" as const,
  keywordCase: "upper" as const,
  linesBetweenQueries: 1,
  tabWidth: 2,
} satisfies Parameters<typeof format>[1];

// ─── Pre-processor ─────────────────────────────────────────────────────────

/**
 * Multi-word fused keyword patterns (longest / most-specific first).
 *
 * Uses \b (word boundary) to match the keyword regardless of whether it is
 * preceded by a word character, a closing quote, or whitespace.  This handles
 * both "cc_stockISNOTNULL" (word char before) and "cc_stock ISNOTNULL"
 * (space before, still a valid match at the word boundary).
 */
const MULTIWORD_FUSIONS: Array<[RegExp, string]> = [
  // Three-word fusions
  [/\bISNOTNULLGROUPBY\b/gi, "IS NOT NULL GROUP BY"],
  [/\bISNOTNULLORDERBY\b/gi, "IS NOT NULL ORDER BY"],
  [/\bISNOTNULL\b/gi, "IS NOT NULL"],
  // Two-word fusions
  [/\bGROUPBY\b/gi, "GROUP BY"],
  [/\bORDERBY\b/gi, "ORDER BY"],
  [/\bPARTITIONBY\b/gi, "PARTITION BY"],
  [/\bLEFTJOIN\b/gi, "LEFT JOIN"],
  [/\bRIGHTJOIN\b/gi, "RIGHT JOIN"],
  [/\bINNERJOIN\b/gi, "INNER JOIN"],
  [/\bFULLJOIN\b/gi, "FULL JOIN"],
  // ISNOT (without NULL following) — must come after ISNOTNULL patterns
  [/\bISNOT(?!NULL)\b/gi, "IS NOT"],
];

/**
 * Single-keyword list for the adjacency pass.
 * Each keyword will get a space inserted before it when directly preceded by
 * a non-whitespace, non-open-paren, non-comma character.
 * Deliberately excludes NULL (handled in multi-word pass) and names that are
 * common identifier substrings (IN, AT, BY, OF, etc.) to avoid false positives.
 */
const SINGLE_KEYWORDS = [
  "SELECT",
  "DISTINCT",
  "FROM",
  "WHERE",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "JOIN",
  "ON",
  "USING",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "FILTER",
  "OVER",
  "RETURNING",
  "DATE",
  "INTERVAL",
  "NOT",
  "AND",
  "OR",
  "AS",
  "IS",
  "COUNT",
  "SUM",
  "AVG",
  "MAX",
  "MIN",
  "COALESCE",
  "NULLIF",
  "ROUND",
  "CAST",
  "EXTRACT",
];

/**
 * Insert spaces between fused SQL keyword tokens so that sql-formatter can
 * parse the query correctly.
 *
 * Examples:
 *   "SELECTCOUNT(*)AS skus" → "SELECT COUNT(*) AS skus"
 *   "cc_stock ISNOTNULLGROUPBY" → "cc_stock IS NOT NULL GROUP BY"
 *   'p."ccrefejofacm"AS"Ref"' → 'p."ccrefejofacm" AS "Ref"'
 */
function preProcessFusedKeywords(sql: string): string {
  let result = sql;

  // Pass 1: multi-word fusions (longest patterns first)
  for (const [pat, repl] of MULTIWORD_FUSIONS) {
    result = result.replace(pat, repl);
  }

  // Pass 2: single keywords directly preceded by non-whitespace/paren/comma
  for (const kw of SINGLE_KEYWORDS) {
    const re = new RegExp(`(?<=[^\\s(,])(${kw})\\b`, "g");
    result = result.replace(re, ` $1`);
  }

  // Pass 3: AS followed directly by a double-quoted identifier (e.g. AS"Col")
  result = result.replace(/\bAS"/g, 'AS "');

  return result;
}

/**
 * Format a raw pg_stat_statements query string for human readability.
 *
 * - Pre-processes fused keyword tokens.
 * - Formats with sql-formatter (postgresql dialect) for proper line-breaks and
 *   indentation.
 * - Falls back to the pre-processed string on formatter error.
 * - Always returns a string; never throws.
 */
export function formatPgQueryText(raw: string): string {
  if (!raw || !raw.trim()) return raw;

  const preprocessed = preProcessFusedKeywords(raw);

  try {
    return format(preprocessed, SQL_FORMATTER_OPTIONS);
  } catch {
    // sql-formatter can balk on some pg-specific syntax. Return the
    // pre-processed string — it is already more readable than the raw output.
    return preprocessed;
  }
}
