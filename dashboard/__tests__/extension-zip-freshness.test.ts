// @vitest-environment node
//
// Guards the #334 fix: `scripts/check-extension-zip-fresh.sh` must fail loudly
// when the packaged extension zip is missing or older than the extension source,
// and pass when it is fresh. This is the staleness guard that turns the silent
// "shipped 0.7.0 after 0.7.1 merged" failure into a loud one on any build/deploy
// path that isn't the sanctioned `ps stack update`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-extension-zip-fresh.sh");

function runGuard(repoRoot: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, REPO_ROOT: repoRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Set an absolute mtime (seconds since epoch) on a path. */
function setMtime(p: string, seconds: number) {
  utimesSync(p, seconds, seconds);
}

describe("check-extension-zip-fresh.sh", () => {
  let root: string;
  const srcDir = () => path.join(root, "browser-extension");
  const zip = () => path.join(root, "dashboard", "public", "inmo-tool-extension.zip");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ext-zip-guard-"));
    mkdirSync(path.join(srcDir(), "icons"), { recursive: true });
    mkdirSync(path.join(root, "dashboard", "public"), { recursive: true });
    writeFileSync(path.join(srcDir(), "manifest.json"), '{"version":"0.7.1"}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 when there is no browser-extension/ dir (nothing to protect)", () => {
    rmSync(srcDir(), { recursive: true, force: true });
    const r = runGuard(root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to check/);
  });

  it("exits 1 when the zip is missing", () => {
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/MISSING/);
  });

  it("exits 0 when the zip is newer than all source files", () => {
    writeFileSync(zip(), "zip-bytes");
    // source at t=1000, zip at t=2000 → fresh
    setMtime(path.join(srcDir(), "manifest.json"), 1000);
    setMtime(zip(), 2000);
    const r = runGuard(root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/up to date/);
  });

  it("exits 1 when a source file is newer than the zip (the #334 stale ship)", () => {
    writeFileSync(zip(), "zip-bytes");
    // zip at t=1000, an edited source file at t=2000 → stale
    setMtime(zip(), 1000);
    writeFileSync(path.join(srcDir(), "detect.js"), "// edited after packaging");
    setMtime(path.join(srcDir(), "detect.js"), 2000);
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/STALE/);
    expect(r.stderr).toMatch(/detect\.js/);
  });

  it("ignores dotfiles when comparing (matches what build-extension-zip.sh packages)", () => {
    writeFileSync(zip(), "zip-bytes");
    setMtime(path.join(srcDir(), "manifest.json"), 1000);
    setMtime(zip(), 2000);
    // A newer dotfile must NOT trip the guard — the packager excludes .* files.
    const dot = path.join(srcDir(), ".DS_Store");
    writeFileSync(dot, "junk");
    setMtime(dot, 3000);
    const r = runGuard(root);
    expect(r.code).toBe(0);
  });
});
