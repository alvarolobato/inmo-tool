/**
 * Shared CSS class helper for rendering InteractionLine entries consistently.
 * The admin `/admin/interactions/[request_id]` detail page that used to be
 * this helper's other caller was deleted outright in #653 (`llm_interactions`
 * had 0 rows ever in production); `DashboardGenerateProgressDialog` remains.
 */
import type { InteractionLine } from "@/lib/db-write";

export function interactionLineClass(kind: InteractionLine["kind"] | undefined): string {
  switch (kind) {
    case "tool_call":
      return "font-mono text-blue-400 dark:text-blue-300";
    case "tool_result":
      return "font-mono text-emerald-500 dark:text-emerald-400";
    case "error":
      return "font-mono text-red-400 dark:text-red-300";
    case "assistant_text":
      return "text-tremor-content dark:text-dark-tremor-content";
    case "phase":
    case "meta":
    default:
      return "italic text-tremor-content-subtle dark:text-dark-tremor-content-subtle";
  }
}
