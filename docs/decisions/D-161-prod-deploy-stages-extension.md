---
id: D-161
title: Every deploy path stages the extension from post-pull source, guarded on version content
date: 2026-08-22
group: Plumbing / process
rule: '`ps prod deploy` stages the extension on the host between `git pull` and `docker compose build`, like `ps stack` (D-060). `scripts/check-extension-version-sync.sh` compares VERSION CONTENT (manifest vs. staged version file vs. the zip''s own manifest) and aborts the deploy on disagreement; absent artifacts stay OK.'
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

D-060's mtime guard could not have caught it either: the frozen artifacts carried
a *recent* mtime with *stale* content, which `find -newer` reads as fresh.

**Decision**:
1. `cmd_deploy()` stages the extension **on the host**, after `git pull` and
   before `docker compose build` (`stage_extension_remote()`). The host checkout
   has `browser-extension/`; only the Docker *build context* is narrowed, not the
   filesystem — so the host, not the image build, is the only place this can run.
2. `scripts/check-extension-version-sync.sh` is the content guard: the version in
   `browser-extension/manifest.json` must equal the version in
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
5. The mtime guard stays. The two are complementary and
   `dashboard/__tests__/extension-version-sync.test.ts` pins the division of
   labour so neither is later deleted as a duplicate: mtime catches source edits
   shipped without a version bump, content catches stale bytes behind a fresh
   timestamp.

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
- *Only wire the existing mtime guard into the prod path*: it structurally cannot
  see this failure. Demonstrated: with stale content and fresh mtimes,
  `check-extension-zip-fresh.sh` exits 0 and `check-extension-version-sync.sh`
  exits 1.
- *A new CI workflow job*: blocked by [D-004](D-004-no-worker-workflows.md). The
  tests live in `dashboard/__tests__/`, which the already-live `dashboard-test`
  job runs, so no workflow change is needed.

**Rationale**: The remaining hand-staged deploy path is what rotted; closing it
makes both sanctioned paths correct by construction. The content guard turns the
one failure mode that survived D-060 — right timestamp, wrong bytes — into a
loud one, on the deploy itself and in a test that already runs.

**See**: `cli/commands/prod.sh`, `cli/commands/stack.sh`,
`scripts/check-extension-version-sync.sh`, `scripts/build-extension-zip.sh`,
`dashboard/__tests__/extension-version-sync.test.ts`,
`dashboard/lib/extension-served-version.ts`, issues #693, #334, #527, #637.
