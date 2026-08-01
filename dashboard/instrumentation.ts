/**
 * Next.js instrumentation hook — runs once when the server starts.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Used to:
 *   - Bootstrap config.yaml on first start (if absent).
 *   - Apply PostgreSQL migrations (etl/schema/init.sql, idempotent) so the
 *     dashboard never starts against a DB that's missing tables it requires.
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
            `${process.env.HOME ?? "~"}/.config/powershop-analytics/config.yaml`,
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
  }
}
