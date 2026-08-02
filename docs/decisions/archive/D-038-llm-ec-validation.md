---
id: D-038
title: LLM is scribe, bash is judge — EC validation architecture
date: 2026-05-23
---

# D-038: LLM is scribe, bash is judge — EC validation architecture

*Decided: 2026-05-23*

**Context**: Issue #735 introduced an EC validator agent that automatically verifies Exit Criteria items on GitHub issues after final-phase PRs merge. The key design question was: how much verification logic should the LLM perform vs. deterministic shell scripts?

The risk of full-LLM validation: the LLM can hallucinate that a test exists or passed, that a file was changed, or that a CI run succeeded. Since EC validation produces binary outcomes (closed / not closed), a single wrong call erodes owner trust in the entire system. Once an issue is wrongly closed, finding and reopening it costs more time than the validator saved.

**Decision**: Split roles strictly:
- **Shell scripts** (`parse-ec.sh`, `verify-ec.sh`) make all deterministic calls: does this file exist at the merge SHA? Did the CI run succeed? Does the git diff include this path? These scripts produce structured JSON — verified/not-verified with concrete evidence strings.
- **LLM** (`ec-validator.md` prompt) receives the pre-computed results and formats them into the natural-language comment. The LLM never decides "verified" — it only composes the summary.

This is the "LLM is scribe; bash is judge" principle. The LLM is used only for:
- Parsing EC item text when regex is ambiguous (rare).
- Composing the natural-language summary comment.

All actual verification is shell-based and reproducible.

**Alternatives rejected**:
1. **Full-LLM validation**: Feed the EC items and CI API responses to the LLM and let it decide verified/failed. Rejected: non-deterministic, prone to hallucination on API JSON, hard to audit. A wrong close is a high-trust-cost incident.
2. **Pure-rule validation (no LLM at all)**: Parse EC items with a fixed regex → map to a CI check → binary pass/fail, no natural-language summary. Rejected: EC items are written in natural language and the `*Verified by*` clause can vary significantly. A short-context LLM call (Haiku) for the summary is cheap and produces much more actionable comments for the owner.

**Rationale**: The split keeps cost low (≤1 LLM call per issue, Haiku model), outcomes reproducible, and errors diagnosable. Shell script failures are trivially inspectable from CI logs; LLM hallucination on verification decisions is not.

**Cost constraint**: The validator LLM call uses `claude-haiku-4-5-20251001` by default. This fires on every final-phase merge (triggered by `ai-post-merge-verify.yml`) and on every `ai-validate-ec` label addition. Keeping the model at Haiku bounds cost even at high issue volume.

**Labels introduced**:
- `ai-validate-ec` — owner adds to manually re-trigger the validator on any issue.
- `fact-awaiting-human-validation` — validator adds when human-only EC items remain unticked; signals to the owner that their action is needed before close.

**See**: issue #735, `docs/decisions/D-037-multi-phase-no-auto-close.md` (the multi-phase auto-close guard that the validator complements), `.github/ai-factory/scripts/parse-ec.sh`, `.github/ai-factory/scripts/verify-ec.sh`, `.github/ai-factory/prompts/ec-validator.md`.
