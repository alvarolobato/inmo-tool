/**
 * Single source of truth for which API routes may be reached without the
 * admin credential.
 *
 * Policy: **gated by default**. Every route under `/api/*` requires the admin
 * credential unless it appears in `PUBLIC_API_PATHS` below. This inverts the
 * previous design, where routes were open unless explicitly listed in the
 * middleware matcher — a shape that silently exposed every new route as it was
 * added. Three separate unauthenticated-endpoint bugs (PR #87's extension
 * capture, PR #106's connector config, PR #110's materialize-all) were all
 * instances of that same shape, each patched individually. Gating by default
 * removes the class rather than the instances.
 *
 * `dashboard/__tests__/api-auth-coverage.test.ts` enumerates every
 * `app/api/**‍/route.ts` and asserts it is either public here or gated, so a
 * newly added route cannot silently reopen the hole.
 */

/**
 * Routes intentionally reachable without credentials.
 *
 * Kept deliberately tiny. A path earns a place here only if it is required by
 * an unauthenticated caller that cannot hold a credential (a container
 * orchestrator), AND it exposes no business data.
 */
export const PUBLIC_API_PATHS: readonly string[] = [
  // Docker/k8s liveness probe. Returns a status string and the LLM circuit
  // breaker state — no database access, no business data.
  "/api/health",
  // Docker/k8s readiness probe. Touches the database only to answer
  // "is Postgres reachable and is ETL data fresh" (row counts and a table
  // name from etl_watermarks); no listing, profile, or conversation data.
  // Probes run before any credential is available, so this cannot be gated.
  "/api/ready",
];

/**
 * True when `pathname` is an API route that may be served without credentials.
 * Exact match only — no prefix matching, so a hypothetical `/api/health/secret`
 * would not inherit `/api/health`'s public status.
 */
export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.includes(pathname);
}

/**
 * True when `pathname` is under `/api/` and therefore subject to the
 * gate-by-default policy.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
