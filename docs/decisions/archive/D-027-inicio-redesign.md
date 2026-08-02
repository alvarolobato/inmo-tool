---
id: D-027
title: Inicio redesign — structured home page with 8 regions + /paneles move
date: 2026-05-02
---

# D-027: Inicio redesign — structured home page with 8 regions + /paneles move

*Decided: 2026-05-02*

**Context**: Issue #454. The previous `/inicio` route rendered a flat grid of ~9 KPIs via `DashboardRenderer` + a legacy SQL template (`lib/templates/inicio.ts`). It had no hierarchy, no period comparison, no store ranking, no alert layer, and no operational metrics split between retail and wholesale.
**Decision**:
- Complete redesign of `/inicio` as a bespoke React page (not template-driven), structured in 8 vertical regions: page header, hero "Ventas hoy en directo", 4-period comparison grid, daily trend chart + alerts panel, retail operations row, wholesale operations row, top-10 stores table, system health footer.
- New `dashboard/components/home/` component family: `HeroToday`, `PeriodGrid`, `DailyTrendChart`, `AlertsPanel`, `OperationsRow`, `TopStoresTable`, `HealthFooter`, `Sparkline` (`HomeSparkline`), `Delta`, `SectionHeader`. All use plain React + inline styles + existing CSS variable tokens from `globals.css`.
- New `dashboard/lib/home-types.ts` defines `HomeViewModel` and `Metric` types (canonical shape for both the API route and the page).
- New `GET /api/home` route returns deterministic mock data matching the issue spec. Real SQL aggregation deferred to a follow-up issue.
- **`/` (root) now renders the new home** (re-exports `inicio/page`). Dashboard list moved to `/paneles`. TopBar `Paneles` link updated from `/` to `/paneles`. TopBar gains a 4th nav item `Glosario` at `/glossary`.
- `lib/templates/inicio.ts` left unchanged (still imported by legacy code; no longer reachable via the `/inicio` route but breaking its imports would break unrelated tests and builds).
- The `/api/home` mock is clearly marked `// TODO(#454-followup)` pointing to the follow-up SQL aggregation issue.
**Alternatives rejected**:
- Keeping `DashboardRenderer` for the new home (it generates generic widget chrome and cannot achieve the custom SVG charts + hero layout required).
- Using Tremor components (issue forbids it for these bespoke components; CSS variable theming must be consistent).
- Redirecting `/` to `/inicio` (breaks existing bookmarks; the re-export approach is forward-compatible).
**See**: `dashboard/app/inicio/page.tsx`, `dashboard/app/page.tsx` (re-export), `dashboard/app/paneles/page.tsx`, `dashboard/components/home/`, `dashboard/lib/home-types.ts`, `dashboard/app/api/home/route.ts`, `dashboard/components/TopBar.tsx`, `dashboard/components/widgets/format.ts` (added `fmtEUR0`, `fmtEUR2`, `fmtPctSigned`, `fmtX`).
