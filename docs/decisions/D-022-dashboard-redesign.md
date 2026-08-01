---
id: D-022
title: Dashboard redesign — token-driven "data newsroom" visual system
date: 2026-04-24
---

# D-022: Dashboard redesign — token-driven "data newsroom" visual system

*Decided: 2026-04-24*

**Context**: Issue #404 — visual redesign to a dark-first, hierarchy-driven "data newsroom" layout.
**Decision**: Implement a CSS variable token layer (`--bg`, `--fg`, `--accent`, `--up`/`--down`/`--warn`) on the `html` element with `data-theme`/`data-accent`/`data-density`/`kpiStyle` attributes. Replace the Tremor-centric sidebar layout with a sticky 56px TopBar. Re-skin all widgets (KPI editorial cards with sparklines and anomaly rings, custom SVG charts, ranked bar chart, table heat cells). Add LogBlock streaming transparency to chat sidebar. Add TweaksPanel for theme/accent/density control.
- **Phases A-D**: Tokens, TopBar, widget re-skin (KpiRow, BarChart, LineChart, AreaChart, DonutChart, Table, InsightsStrip, RankedBars, Sparkline), Panel chrome.
- **Phases E-H**: ChatSidebar rebuilt with two independent message histories + suggestion chips; LogBlock component (streaming + collapsed); AnalyzeLauncher floating rail; TweaksPanel with 4 radio groups; `chat_messages_modify` DB column + API wiring; `docs/skills/dashboard-redesign.md` skill.
**Rationale**: Token-driven theming avoids hardcoded Tailwind class switches; CSS variable swaps are instant. The "data newsroom" hierarchy matches the retail sales manager's morning scan pattern (KPIs → anomalies → drivers → trends). TweaksPanel gives power users control without cluttering the main UI.
**See**: `dashboard/app/globals.css` (tokens), `dashboard/components/TopBar.tsx`, `dashboard/components/TweaksPanel.tsx`, `dashboard/components/LogBlock.tsx`, `dashboard/components/ChatSidebar.tsx`, `dashboard/components/AnalyzeLauncher.tsx`, `docs/skills/dashboard-redesign.md`.
