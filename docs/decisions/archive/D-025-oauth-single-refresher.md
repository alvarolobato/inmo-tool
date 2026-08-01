---
id: D-025
title: Single-refresher rule for Claude OAuth — host launchd is the only refresher
date: 2026-04-27
updated: 2026-05-20
---

# D-025: Single-refresher rule for Claude OAuth — host launchd is the only refresher

*Decided: 2026-04-27 · Updated: 2026-05-20*

**Context**: Issue #440. The dashboard's CLI provider needs the host's Claude OAuth credentials. On macOS those live in the Keychain entry `Claude Code-credentials`. Earlier this week (`8f22c97`) the container's entrypoint refreshed the token through `claude.ai/api/auth/oauth/token` whenever access expired within an hour. OAuth refresh-token rotation issues a new refresh_token on every successful refresh and revokes the previous one — so the container's refresh wrote the new refresh_token to `~/.claude/.credentials.json` while the Keychain still held the now-revoked old one. The next time host claude tried to use the Keychain it got 401 invalid_grant, forcing the user to `claude /login`. D-025 is the post-mortem.

**Decision (original — 2026-04-27)**:
- The Keychain entry is the **single source of truth** for the OAuth payload.
- Only the host claude CLI ever refreshes it. The container never refreshes.
- A launchd agent mirrors the Keychain into `~/.claude/.credentials.json` every 2 h so the container can read it.

**Update — 2026-05-20 (1-year token via `claude /install-github-app`)**:

`claude /install-github-app` issues a **1-year OAuth token** (not the short-lived ~8 h access token) and writes it to both the Keychain and `~/.claude/.credentials.json`. This token:
- Is stored as `CLAUDE_CODE_OAUTH_TOKEN` env var in the container (set in `.env` / `docker-compose.yml`)
- Is passed to the `claude` CLI which reads it directly — **no file mount required**
- Expires in 1 year; no refresh needed until then
- Is also used by GitHub Actions workflows (same secret, same mechanism)

The core rule of D-025 still applies: **never refresh the token from inside the container**. With a 1-year token, no refresh is needed for a year.

**Practical consequence**:
- The `~/.claude` directory bind mount in `docker-compose.yml` has been removed. Credentials flow via env var only.
- The launchd sync (`sync-claude-token.sh`) still runs but only for keeping the local `~/.claude/.credentials.json` fresh for host CLI use. It no longer feeds the container.
- `docker-entrypoint.sh` now reads `CLAUDE_CODE_OAUTH_TOKEN` env var to report token state on boot.
- When the 1-year token expires: run `claude /install-github-app` again, copy the new `~/.claude/.credentials.json` contents into `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, restart the stack.

**Alternatives rejected**:
- **Container-side refresh**: causes the exact bug we are fixing (refresh-token rotation invalidates Keychain copy).
- **Active refresh from a host bash script**: blocked by Cloudflare.
- **Short-lived token + launchd sync**: works but requires constant launchd operation. Superseded by the 1-year token approach.

**See**: `scripts/sync-claude-token.sh`, `dashboard/docker-entrypoint.sh`, `docker-compose.yml`, `.env.example`, `docs/decisions/D-019-pluggable-llm-providers.md`.
