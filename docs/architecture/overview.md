# Architecture — visual overview

This file extracts the ASCII diagrams, dashboard JSON example, and widget tables from `ARCHITECTURE.md`. `ARCHITECTURE.md` keeps the prose, components list, and policy; this file is for visual reference.

## System diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Data Source                                                             │
│   4D Server (10.0.1.35)                                                 │
│     ├── P4D SQL :19812  ─┐                                              │
│     └── SOAP :8080       │                                              │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │ ETL (nightly)
┌──────────────────────────▼──────────────────────────────────────────────┐
│ Docker Compose Stack                                                    │
│                                                                         │
│  ┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐  │
│  │  ETL Python  │────▶│  PostgreSQL       │◄────│  Dashboard App      │  │
│  │  (nightly)  │     │  18M+ rows        │     │  (Next.js+Tremor)   │  │
│  └─────────────┘     │  ps_* tables      │     │  :4000              │  │
│                      │  dashboard_* tbls │     └────────┬────────────┘  │
│                      └────────┬─────────┘              │               │
│                               │                         │               │
│  ┌────────────────────────────┼─────────────────────────┼────────────┐  │
│  │  WrenAI Stack              │                         │            │  │
│  │   ├── wren-ui :3000 ───────┘                         │            │  │
│  │   ├── wren-ai-service :5555                          │            │  │
│  │   ├── wren-engine                         OpenRouter │            │  │
│  │   ├── ibis-server                         (Claude)   │            │  │
│  │   └── qdrant                                  ▲      │            │  │
│  └───────────────────────────────────────────────┼──────┘            │  │
│                                                  │                    │  │
└──────────────────────────────────────────────────┼────────────────────┘  │
                                                   │                       │
                                        ┌──────────▼───────────┐          │
                                        │  OpenRouter API       │          │
                                        │  Claude Sonnet 4      │          │
                                        │  text-embedding-3-lg  │          │
                                        └──────────────────────┘          │
```

> **Dashboard App LLM backend is configurable.** `DASHBOARD_LLM_PROVIDER=openrouter` (default, shown above) calls OpenRouter; `=cli` invokes a local Claude Code CLI via argv-array spawn instead. WrenAI always uses OpenRouter. See [D-019](../decisions/D-019-pluggable-llm-providers.md).

## Dashboard App browser ↔ API

```
┌───────────────────────────────────────────────────────┐
│  Browser                                              │
│                                                       │
│  ┌─────────────────┐  ┌───────────────────────────┐  │
│  │  Dashboard View  │  │  Chat Sidebar             │  │
│  │                  │  │                            │  │
│  │  ┌──────────┐   │  │  User: "Créame un cuadro  │  │
│  │  │ KPI Row  │   │  │   de mandos para ventas"  │  │
│  │  ├──────────┤   │  │                            │  │
│  │  │ Bar Chart│   │  │  AI: "He creado un panel   │  │
│  │  ├──────────┤   │  │   con 6 widgets..."        │  │
│  │  │ Table    │   │  │                            │  │
│  │  └──────────┘   │  │  User: "Añade el margen"  │  │
│  │                  │  │                            │  │
│  └─────────────────┘  └───────────────────────────┘  │
└───────────────────────────┬───────────────────────────┘
                            │ REST API
┌───────────────────────────▼───────────────────────────┐
│  Next.js API Routes                                   │
│                                                       │
│  POST /api/dashboard/generate  ← prompt → LLM (+ tools) → spec (saved server-side) │
│  POST /api/conversations/:id/turns ← modify/analyze/chat turns (turn engine) │
│  POST /api/query               ← SQL → PG → data     │
│  GET  /api/dashboard/:id       ← load saved spec      │
│  POST /api/dashboard/:id/save  ← persist spec         │
│  GET  /api/dashboards          ← list all             │
│  POST /api/conversations       ← create conversation  │
│  POST /api/conversations/:id/messages  ← send message (callLlm: true → call LLM) │
│  POST /api/conversations/:id/handoff-to-dashboard  ← mutate conv → dashboard mode (planned — issue #616) │
└───────────────────────────────────────────────────────┘
```

## Dashboard JSON spec example

The LLM generates a JSON specification that the frontend renders:

```json
{
  "title": "Cuadro de Mandos — Ventas Marzo 2026",
  "description": "Panel para el responsable de ventas",
  "widgets": [
    {
      "id": "w1",
      "type": "kpi_row",
      "items": [
        {"label": "Ventas Netas", "sql": "SELECT SUM(total_si) ...", "format": "currency", "prefix": "€"},
        {"label": "Tickets", "sql": "SELECT COUNT(DISTINCT reg_ventas) ...", "format": "number"},
        {"label": "Ticket Medio", "sql": "SELECT SUM(total_si)/COUNT(...) ...", "format": "currency", "prefix": "€"}
      ]
    },
    {
      "type": "bar_chart",
      "title": "Ventas por Tienda",
      "sql": "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas ...",
      "x": "label", "y": "value"
    },
    {
      "type": "line_chart",
      "title": "Tendencia Semanal",
      "sql": "SELECT DATE_TRUNC('week', fecha_creacion) AS x, SUM(total_si) AS y FROM ps_ventas ..."
    },
    {
      "type": "table",
      "title": "Top 10 Artículos",
      "sql": "SELECT p.ccrefejofacm AS \"Referencia\", p.descripcion AS \"Descripción\", ..."
    }
  ]
}
```

## Widget types

| Type | Tremor Component | Purpose |
|------|-----------------|---------|
| `kpi_row` | Card + Metric | Row of KPI numbers (ventas, tickets, ticket medio) |
| `bar_chart` | BarChart | Category comparison (ventas por tienda) |
| `line_chart` | LineChart | Time series (tendencia semanal) |
| `area_chart` | AreaChart | Stacked time series |
| `donut_chart` | DonutChart | Proportions (mix por familia) |
| `table` | Table | Detailed data (top artículos) |
| `number` | Metric | Single big number |
| `insights_strip` | Custom panels | 3-card narrative strip with up/down/warn icons |
| `ranked_bars` | Custom bars | Horizontal bar chart with heat-cell values |

## UI shell components (redesign, Phase A+)

| Component | Purpose |
|-----------|---------|
| `TopBar` | Sticky 56px header — logo, nav, live-data status, cog button, admin link, avatar |
| `TweaksPanel` | Floating panel for theme/accent/density/kpiStyle — opened by TopBar cog |
| `AnalyzeLauncher` | Fixed right-rail button "✦ Analizar con IA" — hidden when chat sidebar open |
| `LogBlock` | Streaming + post-delivery collapsed LLM process log in ChatSidebar |
| `Panel` | Shared widget chrome (title, subtitle, right actions, padded content) |
| `InsightsStrip` | Narrative insight cards — up/down/warn |
| `RankedBarsWidget` | Horizontal bars with heat cells |
| `Sparkline` | 90×24 SVG inline sparkline in KPI editorial cards |
