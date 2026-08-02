---
id: D-014
title: Label-driven AI execution
date: 2026-04-05
---

# D-014: Label-driven AI execution

*Decided: 2026-04-05*

**Context**: Need a mechanism for humans to control which issues AI works on.
**Decision**: Label `ai-work` triggers Claude Code Worker. Label `ai-blocked` pauses. Priority labels (`p0-critical`, `p1-high`, `p2-medium`, `p3-low`) control order. `no-ai` excludes from AI processing.
**Rationale**: Simple, visible, auditable. Human adds label = human approves AI work. See epic #121.
