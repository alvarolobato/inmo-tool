---
id: D-010
title: Build custom AI dashboard generator (Option B)
date: 2026-04-04
---

# D-010: Build custom AI dashboard generator (Option B)

*Decided: 2026-04-04*

**Context**: WrenAI excels at single text-to-SQL queries but cannot generate multi-widget dashboards. Business users need to describe dashboards in natural language and get complete panels.
**Decision**: Build a custom Next.js + Tremor dashboard app that uses the LLM to generate dashboard JSON specs.
**Alternatives rejected**:
- Metabase: No "one prompt → full dashboard" capability. Metabot generates chart-by-chart only.
- Metabase + custom LLM layer (hybrid): Too much coupling complexity for the benefit.
- Evidence.dev: Requires SQL+Markdown writing — not suitable for non-technical users.
- ToolJet: AI features are Enterprise-only (not open source).
**Rationale**: Only custom build delivers the core requirement. We have all the building blocks: 52 SQL pairs, 40 instructions, PostgreSQL with 18M rows, OpenRouter with Claude Sonnet 4. See issue #69 for full analysis.
