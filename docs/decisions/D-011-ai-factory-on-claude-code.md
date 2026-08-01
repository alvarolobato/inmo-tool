---
id: D-011
title: AI Factory with Claude Code as primary agent
date: 2026-04-05
---

# D-011: AI Factory with Claude Code as primary agent

*Decided: 2026-04-05*

**Context**: Need an autonomous development pipeline where scheduled agents discover work, an implementation agent fixes it, and review/deployment agents close the loop. Need to choose the AI engine.
**Decision**: Build an AI Factory using Claude via `anthropics/claude-code-action@v1` GitHub Action. 20 workflows across 6 phases: Foundation, PR Lifecycle, Issue Lifecycle, Discovery Agents, Deployment, Refinement.
**Alternatives considered**: GitHub Copilot SWE Agent, hybrid Copilot+Claude, Google Gemini CLI action.
**Rationale**: Claude is already our LLM for WrenAI and Dashboard App — single vendor, single billing, single rate limit. Claude Code Action is production-ready and reads `CLAUDE.md`/`AGENTS.md` automatically, so the extensive project context we already maintain carries over for free. See epic #121 and [ai-factory.md](../ai-factory.md).
