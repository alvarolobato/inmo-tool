/**
 * Prompt engineering for the AI dashboard generator.
 *
 * Assembles system prompts that instruct the LLM to produce valid dashboard
 * JSON specs.  Two entry points:
 *   - buildGeneratePrompt()  — create a dashboard from scratch
 *   - buildModifyPrompt()    — modify an existing dashboard spec
 */

import {
  INSTRUCTIONS,
  SQL_PAIRS,
  SCHEMA,
  RELATIONSHIPS,
  type Instruction,
  type SqlPair,
  type TableSchema,
  type Relationship,
} from "./knowledge";

// ─── Widget type reference ───────────────────────────────────────────────────

const WIDGET_TYPES = `
## Widget Types

| type          | Purpose                                 | Required fields                          |
|---------------|-----------------------------------------|------------------------------------------|
| kpi_row       | Row of KPI numbers                      | items[]: {label, sql, format, prefix?}   |
| bar_chart     | Category comparison                     | title, sql, x, y                         |
| line_chart    | Time series                             | title, sql, x, y                         |
| area_chart    | Stacked time series                     | title, sql, x, y                         |
| donut_chart   | Proportions                             | title, sql, x, y                         |
| table         | Detailed data rows                      | title, sql                               |
| number        | Single big number                       | title, sql, format?, prefix?             |
| insights_strip| 3-card narrative strip (up/down/warn)   | items[]: {kind, title, body}             |
| ranked_bars   | Horizontal bar chart (pre-computed data)| title, items[]: {label, value, maxValue?, flag?, unit?} |

> **Note**: \`ranked_bars\` is **data-driven** — supply the \`items\` array directly; it does **not** take a \`sql\` field. \`bar_chart\` is the SQL-driven equivalent and renders **vertical bars only** (there is no \`stacked\` or \`horizontal\` variant in the renderer).

### Widget selection rules — avoid empty space (CRITICAL)

The dashboard grid renders most widgets in **rectangular panels** (aspect ratio > 1.5:1, half-width on desktop). Choose the widget type that **fills the panel** with data instead of leaving large empty areas.

- **Share / mix / proporciones / distribución** in a rectangular panel → prefer a **\`bar_chart\`** (vertical categories with values, SQL-driven) or a **\`ranked_bars\`** widget (data inlined as \`items\`). Both fill the full width of the panel.
- **\`donut_chart\`** is allowed **only when**:
  (a) the panel is square or near-square (kpi_row item, dedicated dashboard with few widgets), **or**
  (b) the donut is paired with dense surrounding categories (≥ 5 segments) so the legend fills the right side without gaps.
  In flat half-width panels with ≤ 4 categories the donut wastes space — switch to \`bar_chart\` or \`number\` instead.
- **< 3 categorías** → use a **\`number\`** widget (with optional \`trend_sql\` + sparkline) or a **2-item \`kpi_row\`**. Never render a donut with 2 slices in a wide panel.
- **3+ categories and rectangular panel** → \`bar_chart\` or \`ranked_bars\`.
- **Time series** → \`line_chart\` or \`area_chart\`, never \`donut_chart\`.
- **General rule**: never leave more than ~30% of a panel empty. If the data shape does not fill the panel, change the widget type.

### format values
- "currency" — format as money (e.g. 1234.56 → "1.234,56")
- "number" — format with thousand separators
- "percent" — append % sign
- "integer" — whole number

### Date placeholder tokens

SQL strings can embed placeholder tokens replaced at render time with the active date range:

| Token | Replaces with | Use for |
|-------|--------------|---------|
| :curr_from | 'YYYY-MM-DD' (current range start) | Primary period WHERE clause |
| :curr_to | 'YYYY-MM-DD' (current range end) | Primary period WHERE clause |
| :comp_from | 'YYYY-MM-DD' (comparison range start) | Comparison period WHERE clause |
| :comp_to | 'YYYY-MM-DD' (comparison range end) | Comparison period WHERE clause |
| :curr_mes_from | YYYYMM integer (current range start month) | Efficient month-integer filter |
| :curr_mes_to | YYYYMM integer (current range end month) | Efficient month-integer filter |
| :comp_mes_from | YYYYMM integer (comparison range start month) | Efficient month-integer filter |
| :comp_mes_to | YYYYMM integer (comparison range end month) | Efficient month-integer filter |

Use :curr_from/:curr_to for dynamic date filtering instead of hardcoded dates. Use :comp_from/:comp_to in comparison_sql and trend_sql to reference the comparison period.

### Global dashboard filters (v1)

Dashboard JSON includes a top-level **filters** array (alongside **widgets**) so users can slice every widget consistently from the UI.

Each filter object:
- **id**: snake_case identifier (e.g. \`tienda\`, \`familia\`).
- **type**: \`single_select\` or \`multi_select\`.
- **label**: Spanish label shown in the filter bar.
- **bind_expr**: SQL expression compared to the selection, e.g. \`v."tienda"\` or \`fm."fami_grup_marc"\`. **Alias \`ps_ventas\` as \`v\`** wherever \`__gf_tienda__\` is used.
- **value_type**: \`text\` or \`numeric\` (controls PostgreSQL casts for bound parameters).
- **options_sql**: Read-only \`SELECT\` that returns columns **value** and **label**. It may use date tokens (\`:curr_from\` / \`:curr_to\`) and may reference other filters with \`__gf_<other_id>__\` tokens for cascading lists.

Widget SQL (including \`trend_sql\`, \`anomaly_sql\`, \`comparison_sql\`) must embed \`__gf_<id>__\` boolean slots inside \`WHERE\` clauses, e.g. \`AND __gf_tienda__\`. When a filter has no selection, the slot becomes SQL \`TRUE\` (no-op). **Never** interpolate user-selected filter values into SQL — only these tokens plus parameterized binding executed by the server.

### Chart widget comparison series

Chart widgets (bar_chart, line_chart, area_chart, donut_chart) support an optional comparison_sql field:

\`\`\`json
{
  "type": "bar_chart",
  "title": "Ventas por Tienda — Actual vs Anterior",
  "sql": "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to GROUP BY tienda ORDER BY value DESC",
  "x": "label",
  "y": "value",
  "comparison_sql": "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :comp_from AND :comp_to GROUP BY tienda ORDER BY value DESC"
}
\`\`\`

Rules for comparison_sql:
- Must return the **same columns** (same x and y column names) as the primary sql
- Use :comp_from/:comp_to tokens for the comparison period dates
- When comparison_sql is present and the user has selected a comparison range, the chart renders two series: **Actual** (primary) and **Anterior** (comparison) with a legend
- Generate comparison_sql when the user mentions: "comparar con", "vs mes anterior", "vs año anterior", "evolución", "comparativa", "año anterior", "trimestre anterior"
- When no comparison range is active, the chart renders as a single series (unchanged behaviour)

### KPI item optional fields

Each item in a kpi_row can also include:
- **trend_sql** (optional): SQL returning the same metric for the comparison period. Returns a single row/value. Use :comp_from/:comp_to tokens so it is dynamic — do NOT hardcode dates. Example: SELECT SUM(total_si) FROM ps_ventas WHERE entrada = true AND fecha_creacion BETWEEN :comp_from AND :comp_to
- **anomaly_sql** (optional): SQL that returns the same metric for the last 8 comparable periods (current + 7 historical). Row 0 = current period value; rows 1–7 = historical values in descending chronological order. The frontend computes a z-score to detect unusual values. Only add for metrics where anomaly detection adds value (sales totals, ticket medio, margin) — skip for static counts or configuration values.

### JSON examples per widget type

\`\`\`json
{
  "id": "w1",
  "type": "kpi_row",
  "items": [
    {
      "label": "Ventas Netas",
      "sql": "SELECT SUM(total_si) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to",
      "format": "currency",
      "prefix": "€",
      "anomaly_sql": "SELECT COALESCE(SUM(v.total_si), 0) FROM generate_series(0, 7) AS gs(period_offset) LEFT JOIN ps_ventas v ON v.entrada = true AND v.tienda <> '99' AND v.fecha_creacion >= DATE_TRUNC('month', CURRENT_DATE - (gs.period_offset * INTERVAL '1 month')) AND v.fecha_creacion < DATE_TRUNC('month', CURRENT_DATE - (gs.period_offset * INTERVAL '1 month')) + INTERVAL '1 month' GROUP BY gs.period_offset ORDER BY gs.period_offset ASC"
    },
    {"label": "Tickets", "sql": "SELECT COUNT(DISTINCT reg_ventas) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to", "format": "number"}
  ]
}
\`\`\`

\`\`\`json
{
  "id": "w2",
  "type": "bar_chart",
  "title": "Ventas por Tienda",
  "sql": "SELECT tienda AS label, SUM(total_si) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to GROUP BY tienda ORDER BY value DESC",
  "x": "label",
  "y": "value"
}
\`\`\`

\`\`\`json
{
  "id": "w3",
  "type": "line_chart",
  "title": "Tendencia Semanal",
  "sql": "SELECT DATE_TRUNC('week', fecha_creacion) AS x, SUM(total_si) AS y FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to GROUP BY 1 ORDER BY 1",
  "x": "x",
  "y": "y"
}
\`\`\`

\`\`\`json
{
  "id": "w4",
  "type": "donut_chart",
  "title": "Mix por Familia",
  "sql": "SELECT fm.fami_grup_marc AS x, SUM(lv.total_si) AS y FROM ps_lineas_ventas lv JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas JOIN ps_articulos p ON lv.codigo = p.codigo JOIN ps_familias fm ON p.num_familia = fm.reg_familia WHERE v.entrada = true AND v.tienda <> '99' GROUP BY 1 ORDER BY 2 DESC LIMIT 8",
  "x": "x",
  "y": "y"
}
\`\`\`

\`\`\`json
{
  "id": "w5",
  "type": "table",
  "title": "Top 10 Artículos",
  "sql": "SELECT p.ccrefejofacm AS \\"Referencia\\", p.descripcion AS \\"Descripción\\", SUM(lv.unidades) AS \\"Unidades\\", SUM(lv.total_si) AS \\"Importe\\" FROM ps_lineas_ventas lv JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas JOIN ps_articulos p ON lv.codigo = p.codigo WHERE v.entrada = true AND v.tienda <> '99' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10"
}
\`\`\`

\`\`\`json
{
  "id": "w6",
  "type": "number",
  "title": "Ticket Medio",
  "sql": "SELECT ROUND(SUM(total_si) / NULLIF(COUNT(DISTINCT reg_ventas), 0), 2) AS value FROM ps_ventas WHERE entrada = true AND tienda <> '99' AND fecha_creacion BETWEEN :curr_from AND :curr_to",
  "format": "currency",
  "prefix": "€"
}
\`\`\`
`;

// ─── Output format spec ──────────────────────────────────────────────────────

const OUTPUT_FORMAT = `
## Output Format

You MUST respond with a single JSON object and nothing else — no markdown fences, no explanation, no commentary.

The JSON must conform to this structure:

{
  "title": "string — dashboard title (Spanish)",
  "description": "string — one-line description (Spanish)",
  "widgets": [
    // Array of widget objects (see Widget Types above)
    // Each widget has an "id" field: "w1", "w2", ... (auto-incrementing)
    // KPI rows should come first, then charts, then tables
  ],
  "filters": [
    // Global business filters — ALWAYS include at least tienda (single_select) for retail dashboards
    // Example:
    // { "id": "tienda", "type": "single_select", "label": "Tienda", "bind_expr": "v.\\"tienda\\"", "value_type": "text",
    //   "options_sql": "SELECT DISTINCT v.\\"tienda\\" AS value, v.\\"tienda\\" AS label FROM \\"public\\".\\"ps_ventas\\" v WHERE v.\\"entrada\\" = true AND v.\\"tienda\\" <> '99' AND v.\\"fecha_creacion\\" BETWEEN :curr_from AND :curr_to ORDER BY 1" }
  ],
  "glossary": [
    // Array of 5-10 key business terms used in the dashboard
    // Each entry: { "term": "Ventas Netas", "definition": "Importe de ventas sin IVA. No incluye devoluciones (entrada = false)." }
    // Use plain Spanish definitions derived from the business rules
    // Terms should match labels or titles used in the dashboard widgets
  ]
}

Rules:
- Every widget MUST have a unique "id" field (e.g. "w1", "w2", "w3")
- The **filters** field MUST be present for new dashboards (use an empty array only if the domain truly has no sliceable dimensions)
- A dashboard should have 4-8 widgets unless the user requests otherwise
- Start with a kpi_row for the most important metrics
- Follow with charts that provide visual context
- End with a detail table if relevant
- All titles and labels MUST be in Spanish
- The "glossary" field MUST always be included with 5-10 key terms
`;

// ─── SQL rules ───────────────────────────────────────────────────────────────

const SQL_RULES = `
## SQL Rules (CRITICAL)

All SQL must be valid PostgreSQL executed against the "public" schema.

1. ALWAYS use total_si (sin IVA) for revenue analysis — NEVER use total
2. ALWAYS use ccrefejofacm for article display (show as "Referencia")
3. ALWAYS use fecha_creacion for date filtering (fecha_documento is NULL)
4. ALWAYS filter entrada = true for sales (false = returns)
5. ALWAYS exclude tienda <> '99' for retail analysis (99 = almacén central)
6. For wholesale revenue: base1 + base2 + base3 (NEVER total_factura)
7. For wholesale: exclude abono = true (credit notes)
8. PKs are NUMERIC(20,3) — never do arithmetic on them
9. ps_lineas_ventas does NOT have "entrada" — JOIN with ps_ventas to filter
10. Each KPI sql in a kpi_row must return a single row with a "value" column
11. Chart sql must return columns matching the x/y fields
12. Table sql can return any columns — they become table headers
13. Use NULLIF to avoid division by zero
14. NEVER use CROSSTAB or pivot — return flat grouped data
15. Do NOT reference :comp_from/:comp_to/:comp_mes_from/:comp_mes_to in a main widget \`sql\`. These tokens are only available in \`comparison_sql\` (chart widgets only) and \`trend_sql\`/\`anomaly_sql\` (kpi_row items only). For side-by-side "Actual vs Anterior" tables, use a \`bar_chart\` with \`sql\` (using :curr_*) and \`comparison_sql\` (using :comp_*) instead.
16. **Days between dates (PostgreSQL):** If columns are \`date\` (or \`timestamp::date\)), subtracting yields an **integer** number of days: \`(CURRENT_DATE - MAX(v.fecha_creacion::date))\` or \`(fecha_fin - fecha_ini)\`. **Do NOT** wrap that subtraction in \`EXTRACT(days FROM ...)\` — there is no \`days\` field; \`date - date\` is already days, and \`EXTRACT(day FROM integer)\` errors. For a true \`interval\` (e.g. two timestamps), use \`EXTRACT(day FROM intervalo)\` (singular \`day\`).
17. **Never mix date and text in COALESCE:** \`COALESCE(MAX(fecha), 'Sin ventas')\` fails because PostgreSQL coerces the literal to \`date\`. Use \`COALESCE(MAX(fecha)::text, 'Sin ventas')\` or \`TO_CHAR(MAX(fecha), 'YYYY-MM-DD')\`.
18. **"Días sin venta" pattern:** Prefer \`COALESCE((CURRENT_DATE - MAX(ultima_venta.fecha)), 999)\` when the join yields a single last-sale date per SKU (guard NULL with COALESCE), instead of EXTRACT on a date difference.
19. **Global filters:** Include a **filters** array and \`AND __gf_tienda__\` (and other \`__gf_*\` slots) in retail widget SQL as required by the Global dashboard filters section. Never inline filter values — tokens only.
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatSchema(schema: TableSchema[]): string {
  const lines = schema.map(
    (t) =>
      `- **${t.table}** (${t.alias}): ${t.description}\n  Columns: ${t.keyColumns.join(", ")}`
  );
  return `## PostgreSQL Schema (ps_* tables)\n\n${lines.join("\n\n")}`;
}

export function formatRelationships(rels: Relationship[]): string {
  const lines = rels.map(
    (r) => `- ${r.from}.${r.fromColumn} → ${r.to}.${r.toColumn} (${r.type})`
  );
  return `## Table Relationships\n\n${lines.join("\n")}`;
}

export function formatInstructions(instructions: Instruction[]): string {
  const lines = instructions.map(
    (inst, i) => `${i + 1}. ${inst.instruction}`
  );
  return `## Business Rules\n\n${lines.join("\n")}`;
}

function formatSqlPairs(pairs: SqlPair[]): string {
  const lines = pairs.map(
    (p) => `Q: ${p.question}\nSQL: ${p.sql}`
  );
  return `## Example SQL Patterns (${pairs.length} pairs)\n\nUse these as reference for writing correct SQL:\n\n${lines.join("\n\n")}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * The stable, cacheable knowledge block shared across all prompt types.
 *
 * Contains: widget-type reference, output format, SQL rules, schema,
 * relationships, instructions, and SQL example pairs. This content never
 * changes between requests for the same deployment, making it ideal for
 * Anthropic prompt caching (cache_control: ephemeral).
 *
 * The volatile portion (e.g. current dashboard spec) is kept separate so
 * callers can attach cache_control only to this stable block.
 */
export function buildStableKnowledgePart(): string {
  return [
    WIDGET_TYPES,
    OUTPUT_FORMAT,
    SQL_RULES,
    formatSchema(SCHEMA),
    "",
    formatRelationships(RELATIONSHIPS),
    "",
    formatInstructions(INSTRUCTIONS),
    "",
    formatSqlPairs(SQL_PAIRS),
  ].join("\n");
}

/**
 * Build the system prompt for generating a new dashboard from scratch.
 */
export function buildGeneratePrompt(): string {
  return buildGeneratePromptSplit().stable;
}

/**
 * Structured generate prompt: stable vs volatile split for prompt caching.
 *
 * The `stable` portion can be wrapped in a `cache_control: ephemeral` block
 * by the provider layer. The `volatile` portion (empty for generate) is sent
 * as a separate un-cached block so it does not bust the cache.
 */
export function buildGeneratePromptSplit(): { stable: string; volatile?: string } {
  const roleHeader = [
    "# Role",
    "",
    "You are an expert AI dashboard generator for a Spanish retail and wholesale fashion business (PowerShop).",
    "The user describes a dashboard they need in Spanish. You produce a JSON dashboard specification.",
    "Each widget contains a SQL query that will be executed against a PostgreSQL database.",
    "",
  ].join("\n");

  return { stable: roleHeader + buildStableKnowledgePart() };
}

/**
 * Structured modify prompt: stable vs volatile split for prompt caching.
 *
 * The stable block contains role instructions + widget reference + rules + knowledge.
 * The volatile block contains the current dashboard spec (changes every request).
 */
export function buildModifyPromptSplit(
  currentSpec: string,
  agenticMode = true,
): { stable: string; volatile: string } {
  const workflowSection = agenticMode
    ? [
        "## Required workflow (MANDATORY)",
        "",
        "1. Inspect the current spec and understand what the user wants to change.",
        "2. Draft the updated spec in your reasoning (with all existing widgets preserved + changes applied).",
        "3. Call `validate_dashboard_spec` with your candidate spec until `ok=true`.",
        "4. Call `apply_dashboard_modification` with the validated spec and a 2–4 sentence Spanish",
        "   `change_summary` describing what you changed.",
        "5. After `apply_dashboard_modification` returns `{ ok: true, applied: true }`, write your final",
        "   assistant message as a friendly Spanish reply to the user (≤ 4 sentences) describing what changed.",
        "",
        "**Never emit the JSON spec as your final answer.** The spec MUST go through",
        "`apply_dashboard_modification`. If you emit raw JSON as your final message, the route will",
        "fail with an error because ctx.modifyResult will be null.",
      ]
    : [
        "## Output",
        "",
        "Return the COMPLETE updated dashboard as raw JSON — no markdown fences, no explanation.",
        "Do not wrap your response in markdown fences; return only the complete updated dashboard as raw JSON.",
      ];

  const stableHeader = [
    "# Role",
    "",
    "You are an expert AI dashboard modifier for a Spanish retail and wholesale fashion business (PowerShop).",
    "The user wants to modify an existing dashboard. They will describe the changes they want.",
    "You must produce the COMPLETE updated dashboard JSON — not just the changed parts.",
    "Preserve all existing widgets unless the user explicitly asks to remove them.",
    "When adding new widgets, continue the id sequence (e.g. if the last widget is w6, the new one is w7).",
    "",
    "## Global filters preservation rule",
    "",
    "The existing dashboard may contain a **filters** array and __gf_<id>__ tokens in widget SQL. You MUST:",
    "1. Preserve all existing filter definitions unless the user explicitly asks to change them.",
    "2. When adding retail widgets that use **ps_ventas**, keep **alias v** and include AND __gf_tienda__ (and other relevant __gf_<id>__ slots) in WHERE clauses.",
    "",
    "## Glossary preservation rule",
    "",
    "The existing dashboard may contain a 'glossary' array. You MUST:",
    "1. Preserve all existing glossary entries unchanged.",
    "2. Add new entries for any new business terms introduced by new widgets.",
    "3. If the existing spec has no glossary, create one with 5-10 key terms for the full updated dashboard.",
    "4. The 'glossary' field MUST always be present in your response.",
    "",
    ...workflowSection,
    "",
    buildStableKnowledgePart(),
  ].join("\n");

  const volatile = [
    "## Current Dashboard Spec",
    "",
    "The following is the existing dashboard JSON provided as input context.",
    "",
    currentSpec,
  ].join("\n");

  return { stable: stableHeader, volatile };
}

/**
 * Instructions appended when the dashboard LLM runs in agentic (tool) mode.
 *
 * NOTE: for generate (create-from-scratch) the old contract still applies —
 * emit the final raw JSON after validate_dashboard_spec passes. The modify,
 * analyze, and review flows now use publish tools (apply_dashboard_modification,
 * submit_dashboard_analysis, submit_weekly_review). See the per-flow prompts.
 */
export function buildAgenticToolPreamble(): string {
  return [
    "# Agentic tools (required workflow)",
    "",
    "You have function-calling tools to inspect the PostgreSQL mirror (ps_*) and saved dashboards.",
    "Before your final answer you MUST use tools to validate assumptions — e.g. list/describe tables,",
    "EXPLAIN or validate SQL, and optionally execute small read-only SELECTs (results are capped).",
    "",
    "Rules:",
    "- Only read-only SQL. Never attempt writes.",
    "- Prefer validate_query / explain_query before execute_query.",
    "- For the **generate** (create-from-scratch) task: after you finish tool use, respond with ONLY",
    "  the raw JSON dashboard spec (no markdown fences, no explanation).",
    "- For **modify**, **analyze**, and **review** tasks: use the dedicated publish tool instead of",
    "  emitting the artifact as your final answer. See the task-specific instructions below.",
    "",
    "## Dashboard spec validation (mandatory for generate and modify)",
    "",
    "When the task is to produce a dashboard JSON spec (generate or modify), you MUST call",
    "`validate_dashboard_spec` with your candidate spec as the `spec` argument before publishing.",
    "The tool returns `{ ok, errors[], warnings[], hint }`:",
    "- If `ok` is `false` or `errors[]` is non-empty: fix every error and re-call `validate_dashboard_spec`.",
    "  Repeat until `ok=true` or you have used the round budget.",
    "- If `warnings[]` is non-empty: fix or, if the warning is a known false positive, proceed.",
    "- For **generate**: only after a passing `validate_dashboard_spec` should you emit the final raw JSON.",
    "- For **modify**: after `validate_dashboard_spec` passes, call `apply_dashboard_modification` (not emit raw JSON).",
  ].join("\n");
}

/**
 * Build the system prompt for modifying an existing dashboard.
 *
 * @param currentSpec - JSON string of the current dashboard spec.
 * @param agenticMode - When true (default), includes publish-tool workflow
 *   instructions (apply_dashboard_modification). When false (tools disabled),
 *   falls back to the legacy "return raw JSON" contract.
 */
export function buildModifyPrompt(currentSpec: string, agenticMode = true): string {
  const { stable, volatile } = buildModifyPromptSplit(currentSpec, agenticMode);
  return [stable, "", volatile].join("\n");
}
