# dashboard-redesign skill

Token system, component map, and guidelines for the redesigned PowerShop Analytics Dashboard App.

## When to use this skill

When modifying or building on top of the redesigned dashboard shell — Phase A onwards (issue #404). This skill covers the token-driven "data newsroom" visual system, new components, and patterns introduced by the redesign.

## CSS variable token system

All tokens are declared on the `html` element in `dashboard/app/globals.css`. The theme is set via `data-theme`, accent via `data-accent`, density via `data-density`.

### Background/Foreground tokens

| Token | Purpose |
|-------|---------|
| `--bg` | Page background |
| `--bg-1` | Card / panel background |
| `--bg-2` | Input / subtle fill |
| `--fg` | Primary text |
| `--fg-muted` | Secondary text |
| `--fg-subtle` | Tertiary / caption |

### Semantic color tokens

| Token | Purpose |
|-------|---------|
| `--accent` | Primary accent (interactive, links) |
| `--accent-soft` | Accent background (chips, badges) |
| `--accent-2` | Secondary accent (tool icons in LogBlock) |
| `--up` / `--up-bg` | Positive delta (green) |
| `--down` / `--down-bg` | Negative delta (red) |
| `--warn` / `--warn-bg` | Warning (amber) — for inverted metrics like Devoluciones |

### Border tokens

| Token | Purpose |
|-------|---------|
| `--border` | Default border |
| `--border-strong` | Emphasized border |

### Layout tokens

| Token | Purpose |
|-------|---------|
| `--gap` | Grid gap between widgets |
| `--pad` | Widget inner padding |
| `--kpi-pad` | KPI card padding |
| `--gap-section` | Vertical separation between page sections (e.g. global filters bar → first widget row). Default `1.5rem`; scales with density (`compact: 1rem`, `spacious: 2rem`). |

### Accent variants (data-accent attribute)

| Value | Description |
|-------|-------------|
| `electric` (default) | Blue-indigo accent |
| `citrus` | Yellow-green accent |
| `magenta` | Pink-fuchsia accent |
| `mono` | Neutral gray accent |

### Density variants (data-density attribute)

| Value | Description |
|-------|-------------|
| `compact` | Tighter padding and gaps |
| `comfort` (default) | Standard padding |
| `spacious` | More generous padding |

## Component map

| Component | File | Purpose |
|-----------|------|---------|
| `TopBar` | `dashboard/components/TopBar.tsx` | Sticky 56px header with logo, nav, status dot, cog, admin link, avatar |
| `TopBarWithTweaks` | `dashboard/components/TopBarWithTweaks.tsx` | Wrapper that owns TweaksPanel open/close state, used in layout.tsx |
| `TweaksPanel` | `dashboard/components/TweaksPanel.tsx` | Floating theme/accent/density/kpiStyle panel opened by cog |
| `TweaksPanelProvider` | `dashboard/components/TweaksPanel.tsx` | React context provider for tweaks state; wrap at layout level |
| `AnalyzeLauncher` | `dashboard/components/AnalyzeLauncher.tsx` | Fixed right-rail button "✦ Analizar con IA"; hidden when sidebar open |
| `LogBlock` | `dashboard/components/LogBlock.tsx` | Streaming (pending) and post-delivery (collapsed) LLM log display |
| `ChatSidebar` | `dashboard/components/ChatSidebar.tsx` | AI assistant panel — Modificar + Analizar tabs, LogBlock, suggestion chips |
| `Panel` | inside `DashboardRenderer` | Shared widget chrome with header, subtitle, actions |
| `Sparkline` | inside KpiRow widget | 90×24 SVG sparkline for KPI cards |
| `InsightsStrip` | `dashboard/components/widgets/InsightsStrip.tsx` | 3-card narrative strip widget |
| `RankedBarsWidget` | `dashboard/components/widgets/RankedBarsWidget.tsx` | Horizontal threshold bars with heat cells |

## KPI style guide

Controlled by `kpiStyle` tweak (persisted in `localStorage` key `ps.tweaks.v1`). Read via `useKpiStyle()` from `TweaksPanel`.

| Style | Description |
|-------|-------------|
| `editorial` (default) | 34px number, delta chip (▲/▼ + %), sparkline, anomaly ring, comparison value |
| `bold` | 42px number, simplified — delta chip + "vs anterior" |
| `minimal` | 28px number, one-line delta + comparison |

## Anomaly + warn rules

- **Anomaly cards**: `border: 1px solid var(--down)` + `box-shadow: 0 0 0 3px var(--down-bg)`. Badge: `● ANOMALÍA DETECTADA` in `--down` color.
- **Warn + inverted**: delta chip uses `--warn`/`--warn-bg`. Rising is bad (e.g. Devoluciones). Set `inverted: true` in KpiItem spec.
- Anomaly is flagged either by `anomaly: true` in the spec or via client-side z-score from `anomaly_sql` data.

## Heat-cell math (table widget)

- Bar width = `(value / columnMax) * 80px`, capped at 80px, min 0
- Bar opacity: 0.15 on fill color
- Used in `RankedBarsWidget` and optionally in `table` widgets

## LogBlock protocol

LogBlock has two states:

**Streaming (pending)**:
- Mount below user message while API call is in flight
- `streaming={true}` prop → dashed border, pulsing accent dot, "Procesando · N paso(s)"
- Lines appear one by one via simulated 400ms intervals

**Post-delivery (collapsed)**:
- Replace streaming block with collapsed block above AI response message
- `streaming={false}` (default) → toggle button "▸ VER LOGS (N)" / "▾ OCULTAR LOGS"
- Arrow rotates 90° on expand (CSS transition 0.15s)

**Line format**: `{timestamp} {kind-icon} {label} · {detail}`
- `kind: tool` → icon `⌬` color `--accent-2`
- `kind: reason` → icon `✦` color `--accent`
- `kind: done` → icon `✓` color `--up`
- `kind: default` → icon `·` color `--fg-subtle`

## ChatSidebar modes

The sidebar has two independent message histories (`modifyMessages` / `analyzeMessages`). Switching tabs swaps histories — no cross-contamination.

- **Modificar tab**: `ConversationPane` posts to `POST /api/conversations/:id/turns`. The server persists the new spec (with a `dashboard_versions` snapshot) via `updateDashboardSpecWithVersion` and emits a `spec_update` SSE event; `onSpecUpdate` only syncs local state — it does NOT re-save.
- **Analizar tab**: same turn engine; shows the markdown response. History lives in `conversation_messages`.

The `AnalyzeLauncher` (floating rail) opens the sidebar directly in analizar mode via `initialMode="analizar"` prop.

## TweaksPanel wiring

1. Wrap layout with `<TweaksPanelProvider>` in `dashboard/app/layout.tsx`
2. Use `<TopBarWithTweaks />` instead of `<TopBar />` directly — it owns the TweaksPanel open/close state
3. Read kpiStyle anywhere via `useKpiStyle()` from `@/components/TweaksPanel`
4. All tweaks persist to `localStorage` key `ps.tweaks.v1` — same key read by the pre-paint script in layout.tsx

## Widget selection rules — avoid empty panels

The grid is two-column on desktop; non-`isFullWidth` widgets render in **rectangular panels** (aspect ratio > 1.5:1). The LLM and any human author should follow these rules to avoid the donut-with-2-slices-and-empty-space problem (see issue #420):

- **Share / mix / proporciones / distribución** → prefer a SQL-driven `bar_chart` (vertical bars) or a data-driven `ranked_bars` (horizontal bars with `items` array). Both fill panel width. Note: the `bar_chart` renderer is vertical-only — there is no `stacked`/`horizontal` variant — so use `ranked_bars` when you need horizontal layout.
- **`donut_chart`** is allowed only when (a) the panel is square or near-square or (b) the donut is paired with ≥ 5 dense surrounding categories. **Do not** use a donut with ≤ 4 categories in a flat half-width panel — it leaves the right ~60% of the panel empty.
- **< 3 categorías** → `number` (with optional `trend_sql` + sparkline) or 2-item `kpi_row`.
- **General rule**: never leave more than ~30% of a panel empty. If the data shape does not fill the panel, change the widget type.

These rules are mirrored in `dashboard/lib/prompts.ts` (`WIDGET_TYPES` block) and must be kept in sync.

## chat_messages_modify DB column

Added as `ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS chat_messages_modify JSONB DEFAULT '[]'::jsonb` in `etl/schema/init.sql`. Returned in GET and accepted in PUT by `dashboard/app/api/dashboard/[id]/route.ts` with the same validation rules as `chat_messages_analyze` (max 200 messages, max 10KB per message).
