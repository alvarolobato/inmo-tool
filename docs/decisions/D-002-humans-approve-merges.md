---
id: D-002
title: Human-in-the-loop for merges (initially)
date: 2026-08-02
---

# D-002: Human-in-the-loop for merges (initially)

## STATUS: retired (2026-08-04) — superseded by [D-029](D-029-agent-merges-after-review.md)

The owner exercised this decision's own expiry condition ("until the owner
decides trust is established") on 2026-08-04. Review did not go away; it moved
to a fresh-context Opus agent. Kept for archaeology.

*Decided: 2026-08-02*

**Context**: This is a personal investment tool with no other consumers, but it does hold personal data extracted from listings (owner contact info, see issue #1 §15) and drives real financial decisions — auto-merging unreviewed changes is not worth the risk this early.
**Decision**: Every branch/PR requires human review and merge. No auto-merge, even for low-risk changes (docs, deps), until the owner decides trust is established for a specific category of change.
**Rationale**: Safety first while the codebase and its review tooling are both new. Carried over from the source project (powershop-analytics D-013).
**See**: `docs/decisions/archive/D-013-humans-approve-merges.md` (original rationale, retained for history).
