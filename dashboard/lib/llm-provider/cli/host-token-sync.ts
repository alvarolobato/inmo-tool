/**
 * On-demand trigger for the host's launchd `claude-token-sync` agent.
 *
 * Background — see docs/decisions/D-025-oauth-single-refresher.md for the full context.
 * The macOS Keychain is the single source of truth for the Claude OAuth
 * payload, refreshed only by the host `claude` CLI during interactive use.
 * A launchd agent on the host mirrors the Keychain into
 * `~/.claude/.credentials.json` every 2 h so the dashboard container can
 * read it. **The container never refreshes the token.**
 *
 * Failure mode this module fixes: a host-side `claude` invocation (e.g. an
 * agent debugging from the same machine) rotates the Keychain refresh_token,
 * which revokes the access_token still cached in the container's mounted
 * credentials file. The next CLI spawn from the container fails with
 * `401 authentication_failed`. Without this helper, the user has to wait
 * up to 2 h for the next launchd cycle (or run the install script manually).
 *
 * On-demand path:
 *   1. The CLI runner detects a 401 / LLM_CLI_AUTH error.
 *   2. It calls `triggerHostTokenSync()`.
 *   3. We touch `/config/.claude-token-kick` (host-mounted rw at
 *      `~/.config/powershop-analytics/.claude-token-kick`).
 *   4. The host launchd agent's `WatchPaths` fires, runs the same
 *      sync-only script (no refresh — D-025 stands), and writes the
 *      current Keychain content into `~/.claude/.credentials.json`
 *      via temp+rename (atomic).
 *   5. We poll the credentials file's mtime; once it advances we know
 *      the file was rewritten and the runner can retry the spawn.
 *
 * This helper is deliberately a no-op when the host plumbing is missing
 * (kick path absent or unwritable, credentials file absent) — a single
 * 401 will then surface to the user as before, with the diagnostic hint
 * to run the install script.
 */

import { stat, utimes } from "node:fs/promises";

/** Default container-side path to the host kick file (bind-mounted rw). */
export const DEFAULT_KICK_PATH = "/config/.claude-token-kick";
/** Default container-side path to the (read-only) credentials mirror. */
export const DEFAULT_CREDS_PATH = "/home/nextjs/.claude/.credentials.json";

export interface TriggerHostTokenSyncOptions {
  /** Override path to the kick file (mostly for tests). */
  kickPath?: string;
  /** Override path to the credentials file used to detect a fresh sync. */
  credsPath?: string;
  /** Maximum total wait for the credentials file mtime to advance, ms. */
  waitMaxMs?: number;
  /** Polling interval while waiting, ms. */
  pollIntervalMs?: number;
}

export type TriggerHostTokenSyncOutcome =
  /** Kick was sent and the credentials file mtime advanced before the timeout. */
  | { ok: true; waitedMs: number; credsPath: string }
  /** Kick was sent but the credentials file did not change in time. The
   *  caller should still retry once — launchd may have fired but the file's
   *  mtime granularity (1 s on HFS+/APFS via Docker volume) can hide a
   *  same-second update. */
  | { ok: true; timeout: true; waitedMs: number; credsPath: string }
  /** Could not even send the kick (kick file missing / not writable, or
   *  credentials path missing). Caller should not retry — it would fail
   *  exactly the same way. The reason is included verbatim for the
   *  diagnostic surface. */
  | { ok: false; reason: string };

async function readMtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/** Touch a path by setting its atime/mtime to "now" via `utimes`. Does NOT
 *  create the file if absent — the install script seeds it. */
async function touchPath(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now);
}

export async function triggerHostTokenSync(
  opts: TriggerHostTokenSyncOptions = {},
): Promise<TriggerHostTokenSyncOutcome> {
  const kickPath = opts.kickPath ?? DEFAULT_KICK_PATH;
  const credsPath = opts.credsPath ?? DEFAULT_CREDS_PATH;
  const waitMaxMs = opts.waitMaxMs ?? 6_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;

  // Snapshot the credentials mtime *before* the kick so we can detect the
  // sync writing a new file. If the credentials path doesn't exist we can't
  // detect anything — surface clearly.
  const beforeMs = await readMtimeMs(credsPath);
  if (beforeMs === null) {
    return {
      ok: false,
      reason: `credentials file not found at ${credsPath} — host launchd agent may not be installed or volume mount is missing`,
    };
  }

  try {
    await touchPath(kickPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `cannot touch kick file at ${kickPath}: ${message} — host launchd agent likely not installed (run scripts/install-claude-token-launchd.sh on the host)`,
    };
  }

  // Poll for mtime advance with exponential-ish steady polling.
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < waitMaxMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const nowMs = await readMtimeMs(credsPath);
    if (nowMs !== null && nowMs > beforeMs) {
      return { ok: true, waitedMs: Date.now() - startedAtMs, credsPath };
    }
  }

  return {
    ok: true,
    timeout: true,
    waitedMs: Date.now() - startedAtMs,
    credsPath,
  };
}
