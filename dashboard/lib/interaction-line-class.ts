/**
 * Shared CSS class helper for rendering InteractionLine entries consistently
 * across DashboardGenerateProgressDialog, ChatSidebar, and admin detail pages.
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
