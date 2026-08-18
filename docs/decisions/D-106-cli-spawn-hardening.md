---
id: D-106
title: CLI spawn hardening — safety flags are unconditional, stdin is EPIPE-safe, cwd is neutral
date: 2026-08-18
group: AI layer
rule: `CLI_SAFETY_ARGS` (`--tools ""`, `--no-session-persistence`) is passed on EVERY CLI call regardless of `dashboard.llm_cli_lean_mode` — disabling tools against untrusted scraped listing text is a security control, not a cost knob. The runner also spawns with a neutral `cwd` and an EPIPE-guarded stdin, and reads the result envelope line-by-line.
---

# D-106: CLI spawn hardening

*Decided: 2026-08-18*

**Context**: Reviewed the sibling `obsidian-meeting-copilot` project, which drives the same `claude -p` binary from a desktop plugin. Its CLI bridge does several things ours did not, and each turned out to correspond to a real defect here. Everything below was verified against our own code rather than copied on faith — one of its practices (`--no-session-persistence`) measured as a no-op on our CLI version and is adopted only as cheap insurance, with that stated.

**Decision**:

1. **`--tools ""` moves out of the cost toggle and becomes unconditional.** It sat inside `CLI_LEAN_ARGS`, gated by `dashboard.llm_cli_lean_mode` ([D-103](D-103-cli-lean-invocation.md)), which meant turning lean mode off — the documented way to debug a flow — silently re-armed Claude Code's built-in Bash/Edit/Write tools. Our prompts carry **untrusted text scraped from listing portals**; a prompt injection inside a property description would then have a code-execution path on the host. The sibling project disables tools with exactly this rationale ("so untrusted transcript content cannot trigger tool calls") where we had justified it only on token cost. A debug toggle must not be able to open a code-execution path, so the security-relevant flags now live in `CLI_SAFETY_ARGS` and are always passed; only the cost flags remain gated.

2. **stdin writes are EPIPE-guarded.** `runCliProcess` wrote the prompt to `child.stdin` with no `error` listener on that stream. `child.on("error")` does not cover it — that only sees spawn failures — so an unhandled stream `error` **took down the whole Node process**. Reproduced directly: `spawn("sh", ["-c", "exit 1"])` plus a 5 MB write gives `UNCAUGHT: EPIPE`, process dead. Not hypothetical for us: assessment prompts with several listings exceed the ~64 KB pipe buffer, so the write cannot complete synchronously, and any fast-failing invocation (rejected flag, auth failure) races it. A regression test spawns a real fast-exiting child with a 5 MB prompt.

3. **The runner spawns with a neutral `cwd` (`os.tmpdir()`).** It inherited the server's working directory, and Claude Code auto-discovers `CLAUDE.md` from the cwd upward. Measured from this repo's root: a trivial prompt pulled in **22,490 extra cached tokens**, and the model could accurately describe the project. The lean flags happen to suppress this today, but relying on one flag combination is fragile — `llm_cli_lean_mode = false`, or simply running the dashboard with `npm run dev` from the repo root, would re-open it. Neutral cwd fixes it structurally.

4. **The result envelope is located line-by-line.** Parsing all of stdout as one JSON document assumes the envelope is the only thing the binary ever prints; a deprecation notice or update nag ahead of it would break `JSON.parse` and silently degrade to "the whole blob is the answer".

5. **Test isolation from the operator's real config.** Not from the sibling project — found because setting `dashboard.llm_enabled: false` on the host (D-105) broke 15 tests. `lib/system-config/loader.ts` falls back to `~/.config/inmo-tool/config.yaml`, so the suite was reading the developer's live config and behaving differently per machine. A `vitest.setup.ts` now points `CONFIG_FILE` at a nonexistent path for every test file.

**Alternatives rejected**:

- *Copy `--no-session-persistence` with the sibling's stated rationale.* Measured first: a `-p` run on Claude Code 2.1.x writes no session file, so the flag buys nothing today. Kept anyway (zero cost, guards a privacy-relevant behaviour if a future version re-enables persistence) but documented as insurance, not as a fix.
- *Copy its `buildEnhancedPath`/`findBinary` binary discovery.* Solves a desktop-plugin problem (Obsidian spawning with a minimal PATH across version managers). We run in a container with `claude` on PATH and an explicit `dashboard.llm_cli_bin` override; importing that machinery would be cargo-culting.
- *Make `writeStdinSafely` tolerate a stdin object without `.on`.* That would paper over a broken test double. The mocks were fixed to mirror the real stream shape instead.

**See**: `dashboard/lib/llm-provider/cli/process.ts` (`writeStdinSafely`, `cwd`), `dashboard/lib/llm-provider/cli/usage.ts` (`CLI_SAFETY_ARGS` vs `CLI_LEAN_ARGS`), `dashboard/lib/llm-provider/cli/claude-code.ts` (`findResultEnvelope`), `dashboard/vitest.setup.ts`, [D-103](D-103-cli-lean-invocation.md).
