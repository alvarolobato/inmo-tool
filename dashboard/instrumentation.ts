/**
 * Next.js instrumentation hook — runs once when the server starts.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Used to:
 *   - Bootstrap config.yaml on first start (if absent).
 *   - Apply PostgreSQL migrations (etl/schema/init.sql, idempotent) so the
 *     dashboard never starts against a DB that's missing tables it requires.
 *   - Start the AI-assessment scheduler (#308) — the dashboard-side background
 *     pass that runs occupancy/condition/redflags/extract for ingested
 *     properties lacking a current verdict, so the candidate feed actually
 *     shows the badges those flows produce (D-052).
 */

export async function register() {
  // Skip in edge runtime (middleware). In all other runtimes (Node.js standalone,
  // dev server) bootstrap the config file. Using `!== "edge"` rather than
  // `=== "nodejs"` is more robust because NEXT_RUNTIME may be undefined outside
  // the edge runtime context.
  if (process.env.NEXT_RUNTIME !== "edge") {
    try {
      const { bootstrapConfigIfMissing } = await import(
        "./lib/system-config/loader"
      );
      const created = bootstrapConfigIfMissing();
      if (created) {
        console.info(
          "[config] config.yaml created on first start at",
          process.env.CONFIG_FILE ??
            `${process.env.HOME ?? "~"}/.config/inmo-tool/config.yaml`,
        );
      }
    } catch (err) {
      // Non-fatal: the app runs fine without config.yaml (falls back to env + defaults)
      console.warn("[config] Could not bootstrap config.yaml:", err);
    }

    // Apply pending schema migrations against PostgreSQL. init.sql is mounted
    // read-only at /app/schema/init.sql and is idempotent (CREATE TABLE
    // IF NOT EXISTS), so running this on every dashboard start is safe and
    // covers the case where the ETL container hasn't been recreated since a
    // new table was added. Non-fatal on error — set SKIP_DB_MIGRATE=1 to
    // disable (e.g. during build prerender when no DB is reachable).
    if (process.env.SKIP_DB_MIGRATE !== "1") {
      try {
        const { applyInitSql } = await import("./lib/migrate");
        const result = await applyInitSql();
        if (result.applied) {
          console.info("[migrate] init.sql applied successfully");
        } else if (result.error) {
          console.warn(
            "[migrate] init.sql NOT applied:",
            result.reason ?? "(unknown)",
            "—",
            result.error,
          );
        } else {
          console.info("[migrate] init.sql skipped:", result.reason);
        }
      } catch (err) {
        console.warn("[migrate] Could not run init.sql migration:", err);
      }
    }

    // Start the AI-assessment background scheduler (#308). Guarded by the same
    // SKIP_DB_MIGRATE flag as the migration above: both need a reachable DB,
    // and build-time prerender (no DB) sets SKIP_DB_MIGRATE=1. The scheduler
    // has its own dashboard.assessment_auto_enabled kill switch and is
    // idempotent, so a double register() never starts two loops. Non-fatal:
    // a failure here must not stop the server from coming up.
    if (process.env.SKIP_DB_MIGRATE !== "1") {
      try {
        const { startAssessmentScheduler } = await import(
          "./lib/ai-assessment/scheduler"
        );
        startAssessmentScheduler();
      } catch (err) {
        console.warn("[ai-assessment] Could not start the assessment scheduler:", err);
      }

      // Start the daily "what's new" digest scheduler (#35, D-054). Same
      // startup seam, DB requirement (SKIP_DB_MIGRATE gate), idempotency, and
      // non-fatal handling as the assessment scheduler above. Its own
      // notifications.digest_auto_enabled kill switch and the SMTP-not-configured
      // no-op mean it is harmless on a deployment without mail set up.
      try {
        const { startDigestScheduler } = await import("./lib/notifications/scheduler");
        startDigestScheduler();
      } catch (err) {
        console.warn("[digest] Could not start the digest scheduler:", err);
      }
    }
  }
}
