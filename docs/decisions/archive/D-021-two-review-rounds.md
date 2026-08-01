---
id: D-021
title: PR review policy capped at two fixed rounds (Copilot → Opus clean-context)
date: 2026-04-24
---

# D-021: PR review policy capped at two fixed rounds (Copilot → Opus clean-context)

*Decided: 2026-04-24*

**Context**: The prior policy (AGENTS.md) required re-requesting Copilot "until no new feedback". In practice this produced long loops where late nit-pick rounds blocked merges without meaningfully improving the code. The human owner called it "too much".
**Decision**: Every PR gets **exactly two review rounds, each run once**:
1. **Copilot** (bot) — request via the REST API pattern already documented. Address each comment with a code change or inline reply, then stop. No re-request.
2. **Opus** — run the PR review flow **from a clean Claude Code context** (fresh session, no prior conversation about the PR or branch) so Opus reviews the diff without being anchored to the implementation history. Address each comment with a change or reply, then stop. No re-request.
Merge after both rounds; if a comment is genuinely blocking and disputed, escalate to the human owner instead of opening a third round.
**Alternatives rejected**: Keeping the "until no feedback" loop (current pain point). Opus-only or Copilot-only (loses the cross-check). Running Opus in the implementation session (context bias defeats the purpose of a second opinion).
**Rationale**: Two independent reviewers, each exactly once, bounds the review cost while preserving a cross-check from a different vantage point. The clean-context requirement for Opus is the core of why round 2 is useful — without it, the review is correlated with the implementation.
**See**: `AGENTS.md` "PR and review policy" and issue-template tasks `N-1b` (Copilot) + `N-1c` (Opus).
