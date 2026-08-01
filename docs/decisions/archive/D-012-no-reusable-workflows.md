---
id: D-012
title: Custom workflows instead of reusable action library
date: 2026-04-05
---

# D-012: Custom workflows instead of reusable action library

*Decided: 2026-04-05*

**Context**: GitHub Actions reusable workflow libraries (`uses: org/repo/.github/workflows/x.yml@ref`) let teams share workflow templates across repos.
**Decision**: Build AI Factory workflows directly in this repo. Extract to a reusable library later if we end up with a second consumer.
**Rationale**: We have ~20 workflows, all project-specific. Premature extraction adds indirection and a second repo to maintain. Keep it simple until patterns stabilize.
