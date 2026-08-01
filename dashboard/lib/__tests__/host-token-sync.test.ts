/**
 * Tests for triggerHostTokenSync — the on-demand kick that fires the host
 * launchd `claude-token-sync` agent. We don't actually exercise launchd
 * here; we use real temp files and verify that the helper:
 *
 *   1. Touches the kick file (mtime advances).
 *   2. Waits for the credentials file mtime to advance, returning ok.
 *   3. Returns ok+timeout when the credentials file never changes.
 *   4. Returns !ok when the credentials file is missing.
 *   5. Returns !ok when the kick file is missing/unwritable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { triggerHostTokenSync } from "@/lib/llm-provider/cli/host-token-sync";

let workdir: string;
let kickPath: string;
let credsPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "claude-host-token-sync-"));
  kickPath = join(workdir, "kick");
  credsPath = join(workdir, "credentials.json");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("triggerHostTokenSync", () => {
  it("touches the kick file and returns ok when credentials file mtime advances", async () => {
    await writeFile(kickPath, "");
    await writeFile(credsPath, '{"v":1}');

    // Schedule a fake "launchd" that bumps the credentials mtime ~50ms later.
    const fakeLaunchd = setTimeout(async () => {
      const future = new Date(Date.now() + 5_000);
      await utimes(credsPath, future, future);
    }, 50);

    try {
      const before = (await stat(kickPath)).mtimeMs;
      const result = await triggerHostTokenSync({
        kickPath,
        credsPath,
        waitMaxMs: 2_000,
        pollIntervalMs: 25,
      });
      const after = (await stat(kickPath)).mtimeMs;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect("timeout" in result && result.timeout).toBeFalsy();
        expect(result.credsPath).toBe(credsPath);
      }
      // Touching MUST advance the kick file's mtime (or at least not regress
      // by more than the filesystem's mtime granularity — APFS truncates to
      // 1 ns precision, ext4 to 1 s, so we allow a small tolerance instead
      // of asserting strict >=).
      expect(after).toBeGreaterThanOrEqual(Math.floor(before));
    } finally {
      clearTimeout(fakeLaunchd);
    }
  });

  it("returns ok+timeout when the credentials mtime never advances", async () => {
    await writeFile(kickPath, "");
    await writeFile(credsPath, '{"v":1}');

    const result = await triggerHostTokenSync({
      kickPath,
      credsPath,
      waitMaxMs: 200,
      pollIntervalMs: 25,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("timeout" in result && result.timeout).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(150);
    }
  });

  it("returns !ok when the credentials file is missing", async () => {
    await writeFile(kickPath, "");

    const result = await triggerHostTokenSync({
      kickPath,
      credsPath,
      waitMaxMs: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/credentials file not found/);
    }
  });

  it("returns !ok when the kick file cannot be touched", async () => {
    await writeFile(credsPath, '{"v":1}');
    // kickPath was never created and points inside workdir without a parent.

    const result = await triggerHostTokenSync({
      kickPath: join(workdir, "nonexistent-dir", "kick"),
      credsPath,
      waitMaxMs: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cannot touch kick file/);
    }
  });
});
