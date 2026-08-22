// @vitest-environment node
//
// Guards the #693 fix: the extension version the dashboard SERVES must equal the
// version in `browser-extension/manifest.json`.
//
// Production sat frozen at extension 0.14.9 while main had moved on. The
// artifacts under `dashboard/public/` are git-ignored and staged on the host by
// scripts/build-extension-zip.sh; `ps prod deploy` never re-staged them, so every
// rebuild baked the same stale pair. `GET /api/extension/status` then reported
// servedVersion 0.14.9, updateAvailable("0.14.9","0.14.9") was false, and the
// update prompt never fired — while `GET /api/extension/download` handed out that
// same stale zip. Broken end to end.
//
// NOTE ON WHY #693 SHIPPED (D-161): not because a guard was blind, but because no
// guard ran on that path. check-extension-zip-fresh.sh (mtime) exits 1 on the real
// #693 state — `git pull` rewrites the mtime of every file it changes, so the
// manifest bump left the source newer than the frozen zip. It was simply never
// invoked by `ps prod deploy`. The content guard covers a narrower, separate case.
// Both facts are pinned below so neither claim drifts back.
//
// Three things are pinned here:
//   1. scripts/check-extension-version-sync.sh — the content-based guard, driven
//      hermetically against temp fixtures (plus assert-if-present on this repo).
//   2. That the mtime guard does catch the post-pull #693 shape, and that the two
//      guards divide labour rather than duplicate it.
//   3. The deploy-path ordering in cli/commands/prod.sh — staging must sit
//      between `git pull` and `docker compose build`, per D-060.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SYNC_GUARD = path.join(REPO_ROOT, "scripts", "check-extension-version-sync.sh");
const MTIME_GUARD = path.join(REPO_ROOT, "scripts", "check-extension-zip-fresh.sh");
const PACKAGER = path.join(REPO_ROOT, "scripts", "build-extension-zip.sh");

function run(script: string, repoRoot: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [script], {
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

/** Is `zip` on PATH? The packager needs it; the version-file leg does not. */
function hasZip(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v zip"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("check-extension-version-sync.sh", () => {
  let root: string;
  const srcDir = () => path.join(root, "browser-extension");
  const publicDir = () => path.join(root, "dashboard", "public");
  const manifest = () => path.join(srcDir(), "manifest.json");
  const versionFile = () => path.join(publicDir(), "extension-version.json");
  const zipFile = () => path.join(publicDir(), "inmo-tool-extension.zip");

  /** A manifest shaped like the real one — `manifest_version` first, to pin that
   *  the extractor never mistakes it for the version. */
  const manifestJson = (v: string) =>
    JSON.stringify({ manifest_version: 3, name: "Inmo-Tool Listing Capture", version: v }, null, 2);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ext-ver-sync-"));
    mkdirSync(srcDir(), { recursive: true });
    mkdirSync(publicDir(), { recursive: true });
    writeFileSync(manifest(), manifestJson("0.16.0"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 when there is no browser-extension/ dir (nothing to protect)", () => {
    rmSync(srcDir(), { recursive: true, force: true });
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to check/);
  });

  it("exits 0 when nothing is staged — servedVersion degrades to null, not to a wrong version", () => {
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing staged/);
  });

  it("exits 0 when the staged version file matches the manifest", () => {
    writeFileSync(versionFile(), '{"version":"0.16.0"}\n');
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agree/);
  });

  it("fails when the packaged version disagrees with the manifest (the #693 freeze)", () => {
    writeFileSync(versionFile(), '{"version":"0.14.9"}\n');
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/STALE/);
    expect(r.stderr).toMatch(/manifest\.json says '0\.16\.0'/);
    expect(r.stderr).toMatch(/staged version file says '0\.14\.9'/);
  });

  it("does not mistake `manifest_version` for the version field", () => {
    // manifest_version is 3 and comes first; a sloppy extractor would read "3".
    writeFileSync(versionFile(), '{"version":"0.16.0"}\n');
    expect(run(SYNC_GUARD, root).code).toBe(0);
    writeFileSync(versionFile(), '{"version":"3"}\n');
    expect(run(SYNC_GUARD, root).code).toBe(1);
  });

  it("catches stale CONTENT behind a FRESH mtime — the narrow case mtime cannot see", () => {
    // NOT the #693 production state (see the file header and D-161): there, the
    // pull had rewritten manifest.json's mtime and the mtime guard exits 1. This
    // fixture back-dates the manifest on purpose to construct the *other* case —
    // artifacts whose bytes are stale but whose timestamps are not, reachable when
    // they are copied in from elsewhere rather than built in place.
    writeFileSync(versionFile(), '{"version":"0.14.9"}\n');
    writeFileSync(zipFile(), "zip-bytes");
    const old = 1000;
    const recent = Math.floor(Date.now() / 1000);
    utimesSync(manifest(), old, old);
    utimesSync(versionFile(), recent, recent);
    utimesSync(zipFile(), recent, recent);

    // The mtime guard is satisfied by this construction ...
    expect(run(MTIME_GUARD, root).code).toBe(0);
    // ... and the content guard is the one that catches it. Both exist for a
    // reason; this pins the division of labour so neither gets deleted as a dupe.
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/0\.14\.9/);
  });

  it("the mtime guard DOES catch the real #693 shape: a pulled manifest beside a frozen zip", () => {
    // The correction D-161 records. `git pull` rewrites the mtime of every file it
    // changes, so a manifest bump can never leave the source older than an
    // untouched artifact — stale-content-with-fresh-mtime is unreachable that way.
    // Here the manifest is newer, exactly as a pull leaves it.
    writeFileSync(versionFile(), '{"version":"0.14.9"}\n');
    writeFileSync(zipFile(), "zip-bytes");
    const stale = 1000;
    utimesSync(versionFile(), stale, stale);
    utimesSync(zipFile(), stale, stale);
    utimesSync(manifest(), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));

    const m = run(MTIME_GUARD, root);
    expect(m.code, `${m.stdout}\n${m.stderr}`).toBe(1);
    expect(m.stderr).toMatch(/STALE/);
    // And the content guard independently agrees. #693 needed neither guard to be
    // cleverer — it needed one of them to actually run on the deploy path.
    expect(run(SYNC_GUARD, root).code).toBe(1);
  });

  it("reports WHICH file it could not parse instead of dying silently", () => {
    // These diagnostics were unreachable: `set -euo pipefail` plus a grep that
    // exits 1 on no match aborted the script before any message could print, so an
    // unparseable file exited 1 with empty output. Exit code right, operator lost.
    writeFileSync(versionFile(), "{}\n");
    const bad = run(SYNC_GUARD, root);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/<unparseable>/);
    expect(bad.stderr).toMatch(/extension-version\.json/);

    writeFileSync(manifest(), "{}\n");
    const badManifest = run(SYNC_GUARD, root);
    expect(badManifest.code).toBe(1);
    expect(badManifest.stderr).toMatch(/could not parse a version from/);
  });

  it.runIf(hasZip())(
    "round-trips through the real packager: zip contents and version file both match",
    () => {
      writeFileSync(path.join(srcDir(), "background.js"), "// extension code");
      expect(run(PACKAGER, root).code).toBe(0);
      expect(existsSync(zipFile())).toBe(true);
      expect(JSON.parse(readFileSync(versionFile(), "utf8")).version).toBe("0.16.0");
      expect(run(SYNC_GUARD, root).code).toBe(0);

      // Bump the manifest WITHOUT repackaging — the mutation this guard exists for.
      writeFileSync(manifest(), manifestJson("0.17.0"));
      const stale = run(SYNC_GUARD, root);
      expect(stale.code).toBe(1);
      // Both artifacts are called out: status would lie AND download would serve old bytes.
      expect(stale.stderr).toMatch(/extension-version\.json/);
      expect(stale.stderr).toMatch(/inmo-tool-extension\.zip/);

      // Repackaging clears it.
      expect(run(PACKAGER, root).code).toBe(0);
      expect(run(SYNC_GUARD, root).code).toBe(0);
    },
  );

  it("passes against this repository's own tree (artifacts staged or absent, never wrong)", () => {
    // DELIBERATELY NOT HERMETIC — `npm test` depends on git-ignored local state
    // here, and that is the point: this is the only assertion that looks at real
    // staged artifacts rather than a fixture.
    //
    // Practical consequence, so nobody debugs it twice: if you have run `ps stack`
    // (which stages dashboard/public/) and then bump browser-extension/manifest.json
    // without re-staging, THIS TEST GOES RED on an otherwise unrelated change. That
    // is a true report — your working tree would build an image serving the old
    // version — and the fix is to re-run `bash scripts/build-extension-zip.sh`, not
    // to touch this test. A clean checkout stages nothing and the guard no-ops.
    const r = run(SYNC_GUARD, REPO_ROOT);
    expect(
      r.code,
      `${r.stdout}\n${r.stderr}\n` +
        "If this failed after a manifest bump, re-stage: bash scripts/build-extension-zip.sh",
    ).toBe(0);
  });
});

describe("deploy paths stage the extension between pull and build (D-060, #693)", () => {
  const prodSh = readFileSync(path.join(REPO_ROOT, "cli", "commands", "prod.sh"), "utf8");
  const stackSh = readFileSync(path.join(REPO_ROOT, "cli", "commands", "stack.sh"), "utf8");

  /**
   * The body of a shell function, from `name() {` to the first line that is a
   * bare `}`, with comment lines stripped — ordering must be judged on executed
   * commands, not on prose that happens to mention "build".
   */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`${name}() {`);
    expect(start, `${name}() not found`).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.search(/\n\}/);
    return rest
      .slice(0, end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
  }

  it("ps prod deploy stages after git pull and before docker compose build", () => {
    const body = functionBody(prodSh, "cmd_deploy");
    const pull = body.indexOf("git pull --ff-only");
    const stage = body.indexOf("stage_extension_remote");
    const build = body.indexOf("DC_PROD} build");

    expect(pull, "cmd_deploy should pull").toBeGreaterThan(-1);
    expect(stage, "cmd_deploy must stage the extension — this was the #693 bug").toBeGreaterThan(-1);
    expect(build, "cmd_deploy should build").toBeGreaterThan(-1);
    // Staging pre-pull source and then building is the #334 failure mode.
    expect(stage).toBeGreaterThan(pull);
    expect(stage).toBeLessThan(build);
  });

  it("the remote staging step runs the packager and BOTH guards on the host", () => {
    const body = functionBody(prodSh, "stage_extension_remote");
    expect(body).toMatch(/on_prod .*build-extension-zip\.sh/);
    // The mtime guard is the one that would have caught #693 (D-161); running it
    // here is the actual fix, not an extra.
    expect(body).toMatch(/on_prod .*check-extension-zip-fresh\.sh/);
    expect(body).toMatch(/on_prod .*check-extension-version-sync\.sh/);
    // A disagreeing artifact must stop the deploy, not warn and carry on.
    expect(body).toMatch(/exit 1/);
  });

  it("the prod mtime check is gated on the zip existing, preserving 'nothing staged -> continue'", () => {
    // check-extension-zip-fresh.sh counts a MISSING zip as an error. Ungated, that
    // would turn "this host has never staged an extension" into a refused deploy,
    // reversing D-161's failure policy: absent artifacts degrade servedVersion to
    // null (no prompt), which is safe; only present-and-wrong is not.
    const body = functionBody(prodSh, "stage_extension_remote");
    const gate = body.indexOf("test ! -f dashboard/public/inmo-tool-extension.zip");
    const mtime = body.indexOf("check-extension-zip-fresh.sh");
    expect(gate, "the mtime check must be guarded by a zip-presence test").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(mtime);
  });

  it("ps stack also runs the content guard, not only the mtime one", () => {
    const body = functionBody(stackSh, "stage_extension");
    expect(body).toMatch(/check-extension-zip-fresh\.sh/);
    expect(body).toMatch(/check-extension-version-sync\.sh/);
  });
});
