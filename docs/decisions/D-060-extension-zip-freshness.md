---
id: D-060
title: Extension zip is staged from post-pull source before every build, guarded by a staleness check
date: 2026-08-05
---

# D-060: Extension zip is staged from post-pull source before every build, guarded by a staleness check

*Decided: 2026-08-05*

**Context**: The browser extension served at `GET /api/extension/download` is a
git-ignored build artifact (`dashboard/public/inmo-tool-extension.zip`) produced
by `scripts/build-extension-zip.sh` from the repo-root `browser-extension/`
directory. The dashboard Docker image is built with context `./dashboard`, so
`browser-extension/` is **outside** the build context — the Dockerfile / an npm
`prebuild` hook cannot see the source and cannot regenerate the zip. The zip must
therefore be staged on the host *before* `docker compose --build`.

`ps stack update` did call `build-extension-zip.sh`, but at **script-load time**,
i.e. **before** its own `git pull`. Sequence was: stage (pre-pull source) →
`git pull` (new source arrives) → `docker compose up -d --build` (bakes the
pre-pull zip). So after #321/#332 bumped the extension 0.7.0→0.7.1, a plain
`ps stack update` kept shipping 0.7.0 until someone ran the script by hand
(issue #334; an earlier "still 0.6.0" report was the same class of bug). A bare
`docker compose up -d --build dashboard` bypassed the CLI entirely and never
staged at all.

**Decision**:
1. The extension zip is staged from the **current (post-pull) source**
   immediately before every build path in `cli/commands/stack.sh`. `stage_extension()`
   runs in `cmd_up` (which builds on first run) and in `cmd_update` **after**
   `git pull`, right before `docker compose up -d --build`. Never stage before the
   pull.
2. `scripts/check-extension-zip-fresh.sh` is the staleness guard: it exits
   non-zero when `dashboard/public/inmo-tool-extension.zip` is missing or older
   than any file under `browser-extension/` (dotfiles excluded, matching the
   packager). It runs as a post-stage self-check inside `stage_extension()` (so a
   silently-failing packager is loud, not silent) and is the intended CI gate for
   the bare-`docker compose --build` bypass.

**Alternatives rejected**:
- *npm `prebuild` hook that regenerates the zip inside the Docker build*: impossible
  — `browser-extension/` is outside the `./dashboard` build context, so neither the
  Dockerfile nor an npm script running in the builder can see the source.
- *Move the build context to the repo root / add a root Dockerfile stage*: a large,
  invasive change to how the image is built, for a problem an ordering fix + a guard
  solve directly.
- *Commit the zip*: it is a generated binary artifact; committing it invites merge
  noise and its own staleness.

**Rationale**: The sanctioned redeploy path becomes correct by construction
(stage post-pull source right before build). The guard turns the remaining silent
failure mode (bare docker build, or a broken packager) into a loud one. No manual
step is ever required on the normal path.

**See**: `cli/commands/stack.sh`, `scripts/build-extension-zip.sh`,
`scripts/check-extension-zip-fresh.sh`,
`dashboard/__tests__/extension-zip-freshness.test.ts`, issue #334.
