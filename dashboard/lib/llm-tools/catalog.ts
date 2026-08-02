/**
 * OpenAI-format tool definitions for OpenRouter chat.completions.
 *
 * Named catalogs:
 *   CHAT_TOOLS — read-only data inspection + set_title. The only non-empty
 *                catalog, used by the `chat` flow (#29) and the runner's
 *                default when no override is passed.
 *
 * Structure:
 *   DATA_INSPECTION_TOOLS (private) — read-only SQL + schema introspection
 *   CHAT_TOOLS = DATA_INSPECTION_TOOLS + set_title
 *
 * ## What #24 removed, and why
 *
 * The inherited catalog carried a second tier of dashboard-authoring tools:
 * `validate_dashboard_spec`, `apply_dashboard_modification`,
 * `submit_dashboard_analysis`, plus seven `*_dashboard_*` inspection tools.
 * All of them existed to let the model author and publish BI dashboard specs.
 *
 * #101 deleted the entire dashboard feature (page, routes, viewer components)
 * but deliberately kept these three tools, because at the time they were still
 * named by live chat machinery (turn-background's staged-result handling, the
 * modify/analyze prompts, the e2e mock provider) and pulling them would have
 * destabilised the chat it was preserving. It explicitly deferred the removal
 * to this task, which replaces the whole flow catalog anyway.
 *
 * That deferral is now settled: the modify/analyze flows are gone, so the
 * staged side-channel they wrote into (`ctx.modifyResult` / `ctx.analyzeResult`)
 * has no producer and no consumer, and the tools are unreachable. Removed.
 *
 * The read-only inspection tools survive, renamed off the `ps_*` mirror
 * convention (`list_ps_tables` → `list_tables`), since answering "which of my
 * candidates dropped in price this week" genuinely needs to query the mirror.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** Read-only SQL and schema-introspection tools. */
const DATA_INSPECTION_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "validate_query",
      description:
        "Validate a read-only SQL string: syntax policy, optional cost estimate (EXPLAIN), and static SQL lint hints. Does not return row data.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "Single SELECT/WITH/EXPLAIN statement, no semicolons.",
          },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_query",
      description:
        "Execute a read-only SELECT/WITH against the PostgreSQL mirror of ingested listings. Results are capped (rows/columns/chars).",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "Single SELECT or WITH query only." },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_query",
      description:
        "Return the PostgreSQL JSON plan for EXPLAIN (FORMAT JSON) without ANALYZE (does not execute the query).",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "Single SELECT or WITH query only." },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tables",
      description:
        "List the base tables in the public schema (property, listing, search_profile, profile_listing_state, …). Call this before writing SQL against a table you have not inspected.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_table",
      description:
        "Describe the columns of one table (name, data type, nullability) from information_schema.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name, e.g. 'listing'." },
        },
        required: ["table"],
      },
    },
  },
];

/** Lets the model set a concise conversation title on its first response. */
const SET_TITLE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "set_title",
    description:
      "Set a concise title (5-7 words, Spanish) for this conversation. Call this once in your first response.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Concise conversation title in Spanish (5-7 words).",
        },
      },
      required: ["title"],
    },
  },
};

/**
 * Tools available to the `chat` flow: 5 read-only inspection tools + set_title.
 *
 * Every tool here is read-only by construction — there is no write-capable tool
 * in any catalog. Assessment flows (occupancy/condition/redflags/extract/
 * compare) receive `[]` from `toolsForFlow()` and never enter the tool loop.
 */
export const CHAT_TOOLS: ChatCompletionTool[] = [
  ...DATA_INSPECTION_TOOLS,
  SET_TITLE_TOOL,
];

/** Names of the read-only inspection tools (no side effects). */
export const INSPECTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "validate_query",
  "execute_query",
  "explain_query",
  "list_tables",
  "describe_table",
]);
