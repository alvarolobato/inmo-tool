// @vitest-environment node
//
// Guards the #693 fix: the extension version the dashboard SERVES must equal the
// version in `browser-extension/manifest.json`.
//
// Production sat frozen at extension 0.14.9 while main shipped 0.16.0. The
// artifacts under `dashboard/public/` are git-ignored and staged on the host by
// scripts/build-extension-zip.sh; `ps prod deploy` never re-staged them, so every
// rebuild baked the same stale pair. `GET /api/extension/status` then reported
// servedVersion 0.14.9, updateAvailable("0.14.9","0.14.9") was false, and the
// update prompt never fired — while `GET /api/extension/download` handed out that
// same stale zip. Broken end to end.
//
// Two things are pinned here:
//   1. scripts/check-extension-version-sync.sh — the content-based guard, driven
//      hermetically against temp fixtures (plus assert-if-present on this repo).
//   2. The deploy-path ordering in cli/commands/prod.sh — staging must sit
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

  it("catches stale CONTENT behind a FRESH mtime — the case the mtime guard cannot see", () => {
    // This is precisely the production state in #693: artifacts written recently
    // (today's build) carrying an old version. `find -newer` calls that fresh.
    writeFileSync(versionFile(), '{"version":"0.14.9"}\n');
    writeFileSync(zipFile(), "zip-bytes");
    const old = 1000;
    const recent = Math.floor(Date.now() / 1000);
    utimesSync(manifest(), old, old);
    utimesSync(versionFile(), recent, recent);
    utimesSync(zipFile(), recent, recent);

    // The pre-existing mtime guard is satisfied ...
    expect(run(MTIME_GUARD, root).code).toBe(0);
    // ... and the content guard is the one that catches it. Both exist for a
    // reason; this pins the division of labour so neither gets deleted as a dupe.
    const r = run(SYNC_GUARD, root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/0\.14\.9/);
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
    // Not hermetic on purpose: if a dev or CI runner has staged artifacts, they
    // must agree with the manifest. If none are staged, the guard is a no-op.
    const r = run(SYNC_GUARD, REPO_ROOT);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
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

  it("the remote staging step runs the packager and the version guard on the host", () => {
    const body = functionBody(prodSh, "stage_extension_remote");
    expect(body).toMatch(/on_prod .*build-extension-zip\.sh/);
    expect(body).toMatch(/on_prod .*check-extension-version-sync\.sh/);
    // A disagreeing artifact must stop the deploy, not warn and carry on.
    expect(body).toMatch(/exit 1/);
  });

  it("ps stack also runs the content guard, not only the mtime one", () => {
    const body = functionBody(stackSh, "stage_extension");
    expect(body).toMatch(/check-extension-zip-fresh\.sh/);
    expect(body).toMatch(/check-extension-version-sync\.sh/);
  });
});
