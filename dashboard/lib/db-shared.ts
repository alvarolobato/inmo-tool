import { types, type PoolConfig } from "pg";

const STATEMENT_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;

// ─── BIGINT (int8) type parser — issue #155 ────────────────────────────────
//
// node-postgres returns int8/BIGINT columns as *strings* by default (a JS
// `number` is an IEEE-754 double and cannot hold the full 64-bit range).
// Every BIGSERIAL id / bigint FK / COUNT(*) / SUM(integer) in this schema
// has to be read through this fact, and five independent call sites got it
// wrong in five different ways (a bigint arriving as a string while typed
// `number`, breaking `===` comparisons and Set/Map lookups silently — see
// PR #58, #93, #70, #89, #145 reviews). Registering a single global parser
// here — imported by every module that creates a Pool/Client
// (`buildPgPoolConfig` below) — fixes the whole class at once instead of
// requiring every call site to remember a `Number()` coercion.
//
// Precision tradeoff, assessed deliberately (not ignored): this loses
// precision above `Number.MAX_SAFE_INTEGER` (2^53 - 1 ≈ 9.007e15). Every
// `BIGSERIAL` in etl/schema/init.sql (property.id, listing.id,
// search_profile.id, connector_runs.id, feedback_event.id, ai_assessment.id,
// etc.) is an application-generated sequence starting at 1 — reaching 2^53
// would mean 9 quadrillion rows, several orders of magnitude past anything
// this single-tenant tool will ever ingest. The same holds for every bigint
// *derived* value read in this codebase: COUNT(*)/SUM(<integer column>)
// aggregates over `connector_runs`/`connector_run_results`/`llm_usage`,
// which are bounded by real row counts in the same small-scale schema.
// There is no column in this schema that is genuinely used as a free-range
// 64-bit value (e.g. an external opaque bigint id, a hash, a bit-packed
// field) — if one is ever added, exclude its OID-20 result explicitly
// (e.g. read it via `::text` in the query) rather than relying on this
// global parser.
types.setTypeParser(types.builtins.INT8, (val: string) => (val === null ? null : Number(val)));

/**
 * Build a pg PoolConfig from env vars, with caller-specified pool size.
 * POSTGRES_DSN takes priority; falls back to individual POSTGRES_* env vars.
 */
export function buildPgPoolConfig(opts: { max: number }): PoolConfig {
  const dsn = process.env.POSTGRES_DSN;
  if (dsn) {
    return {
      connectionString: dsn,
      max: opts.max,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    };
  }

  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "inmotool",
    max: opts.max,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  };
}
