/**
 * Public API for the llm-context module.
 *
 * All LLM calls in the dashboard must go through `assembleRequest()`.
 * CI enforces this via `dashboard/scripts/check-llm-context.sh`.
 * Rationale: docs/decisions/D-006-llm-context-centralization.md
 */

export {
  assembleRequest,
  type AssembleResult,
  type AssembleExecutionOpts,
} from "./assemble";

export {
  LLM_FLOWS,
  SINGLE_SHOT_FLOWS,
  isLlmFlow,
  type LlmFlow,
  type FlowVars,
  type ListingSnapshot,
  type RedflagTrendingCandidate,
  type DismissedCandidate,
  type TriageAxis,
  type TriagePropertyInput,
} from "./types";

export {
  buildSystemPrompt,
  buildOccupancyPrompt,
  buildTriagePrompt,
  buildRedflagsPrompt,
  buildExtractPrompt,
  buildComparePrompt,
  buildChatPrompt,
} from "./system-prompt";

export {
  buildHistory,
  capHistory,
  flattenStoredMessage,
  formatToolCallsForHistory,
  HISTORY_MAX_MESSAGES,
  type HistoryMessage,
} from "./history";

export { toolsForFlow } from "./tools";

export {
  formatSchema,
  formatRelationships,
  formatInstructions,
  formatSqlPairs,
} from "./formatters";
