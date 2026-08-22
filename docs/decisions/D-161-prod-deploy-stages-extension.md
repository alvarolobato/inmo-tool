---
id: D-161
title: Every deploy path stages the extension from post-pull source, guarded on version content
date: 2026-08-22
group: Plumbing / process
rule: '`ps prod deploy` stages the extension on the host between `git pull` and `docker compose build`, like `ps stack` (D-060), then runs BOTH guards there: `check-extension-zip-fresh.sh` (mtime — the one that catches a packager that did not run) and `check-extension-version-sync.sh` (version content). Either disagreeing aborts the deploy; absent artifacts stay OK.'
order: 8
---

# D-161: Every deploy path stages the extension from post-pull source, guarded on version content

*Decided: 2026-08-22*

**Context**: The dashboard reported the operator up to date while he ran
extension 0.14.9 and `main` shipped 0.16.0 (#693). `GET /api/extension/status`
answered `{"version":"0.14.9","servedVersion":"0.14.9"}`, so
`updateAvailable()` was correctly `false` and the prompt never fired — and
`GET /api/extension/download` handed back that same 0.14.9 zip. The update path
was broken end to end, not just the notice. The installed 0.14.9 predates block
detection (0.15.0, #637), so the freeze is *why* the operator ran without block
detection for days.

The comparison logic in `dashboard/lib/extension-status.ts` was never at fault.
The inputs were.

`dashboard/public/inmo-tool-extension.zip` and
`dashboard/public/extension-version.json` are git-ignored artifacts staged from
`browser-extension/` by `scripts/build-extension-zip.sh`. The dashboard image is
built with context `./dashboard`, so the extension source is outside it and the
Dockerfile only copies `/app/public` — it can never regenerate them.

[D-060](D-060-extension-zip-freshness.md) established the fix for this exact
class of bug (#334): stage from post-pull source immediately before every build.
But it was only ever applied to `cli/commands/stack.sh`. `cmd_deploy()` in
`cli/commands/prod.sh` went `git pull` → `build` → `up -d` with no staging step,
so every production deploy rebuilt the image around whatever untracked artifacts
an earlier hand-run had left on the host. D-060's "the sanctioned redeploy path
becomes correct by construction" only ever covered one of the two sanctioned
redeploy paths.

D-060's mtime guard would have caught it. It was simply never *invoked* on this
path — that, not any blindness in the guard, is why #693 shipped. Checked against
the real host state rather than assumed: `browser-extension/manifest.json` carried
today's pull timestamp, `dashboard/public/extension-version.json` was two days
older and still pinned at 0.14.9, and `bash scripts/check-extension-zip-fresh.sh`
exited 1 STALE. That is structural, not luck: `git pull` rewrites the mtime of
every file it changes, so a manifest bump always leaves the source *newer* than
frozen artifacts. Fresh-mtime-with-stale-content cannot arise from `git pull` plus
hand-staging at all — only from copying artifacts in from somewhere else.

**Decision**:
1. `cmd_deploy()` stages the extension **on the host**, after `git pull` and
   before `docker compose build` (`stage_extension_remote()`). The host checkout
   has `browser-extension/`; only the Docker *build context* is narrowed, not the
   filesystem — so the host, not the image build, is the only place this can run.
2. **Both** guards run there, because they fail on different things:
   `scripts/check-extension-zip-fresh.sh` (mtime) is what actually detects "the
   packager did not run, or silently failed" — the #693 shape — and
   `scripts/check-extension-version-sync.sh` (content) requires the version in
   `browser-extension/manifest.json` to equal the version in
   `dashboard/public/extension-version.json` **and** the version inside the
   packaged zip's own `manifest.json`.
3. **Absent artifacts are not a failure.** A missing version file degrades
   `servedVersion` to `null` → no update prompt, and the download answers 503
   with the manual-folder fallback. Degrading to "no prompt" is safe; degrading
   to "wrong version" is the bug. Only *present and disagreeing* fails.
4. Deploy failure policy follows the consequence: packaging that fails with
   nothing stale staged only warns (an unrelated backend fix should not be
   blocked by a missing `zip` on the host); packaging that fails while a
   disagreeing artifact is still present **aborts the deploy**, because building
   would bake a version claim we know to be false.
5. The mtime guard stays, and gains the prod path it never had.
   `dashboard/__tests__/extension-version-sync.test.ts` pins the division of
   labour so neither is later deleted as a duplicate. mtime is the broader net:
   any un-repackaged source edit, version bump or not. Content covers the
   narrower residue mtime cannot reach — a staged artifact whose bytes predate an
   un-versioned source edit but whose timestamp does not, which happens when
   artifacts are copied in from elsewhere rather than built in place. Neither
   subsumes the other, but only the mtime one would have fired on #693.

**Alternatives rejected**:
- *Regenerate inside the Docker build (Dockerfile stage or npm `prebuild` hook)*:
  still impossible, and re-verified rather than assumed — both
  `docker-compose.yml` and `docker-compose.prod.yml` set
  `build.context: ./dashboard`, so `browser-extension/` is not in the context.
  Same reason D-060 rejected it.
- *Commit the artifacts instead of ignoring them*: a binary zip in git invites
  merge noise and acquires its own staleness — the untracked copy is what rotted
  here, but a tracked copy rots too if a manifest bump forgets to repackage. The
  generated-at-deploy + guarded invariant removes the human step entirely.
- *Wire ONLY the existing mtime guard into the prod path*: necessary, and adopted
  — but not sufficient on its own, so not the whole answer. It leaves the residual
  hole in point 5: packaging fails, a staged artifact's version string still
  matches, but its bytes predate an un-versioned source edit. mtime reads that as
  fresh, and the deploy ships stale extension code. Demonstrated in the tests:
  with stale content behind fresh mtimes, `check-extension-zip-fresh.sh` exits 0
  while `check-extension-version-sync.sh` exits 1.
- *Drop the content guard as redundant, now that the mtime guard covers #693*: it
  is cheap and the class above is real, if narrower than this decision originally
  claimed. Keeping both is the point of the pinned division of labour.
- *A new CI workflow job*: blocked by [D-004](D-004-no-worker-workflows.md). The
  tests live in `dashboard/__tests__/`, which the already-live `dashboard-test`
  job runs, so no workflow change is needed.

**Rationale**: The remaining hand-staged deploy path is what rotted; closing it
makes both sanctioned paths correct by construction. #693 was an unguarded path,
not an inadequate guard — so the primary fix is running the guards there at all.
The content guard is then a cheap second net for the narrower right-timestamp,
wrong-bytes case, loud on the deploy itself and in a test that already runs.

**See**: `cli/commands/prod.sh`, `cli/commands/stack.sh`,
`scripts/check-extension-version-sync.sh`, `scripts/build-extension-zip.sh`,
`dashboard/__tests__/extension-version-sync.test.ts`,
`dashboard/lib/extension-served-version.ts`, issues #693, #334, #527, #637.
