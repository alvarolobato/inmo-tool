/**
 * Dashboard LLM configuration surface for routes and admin UI.
 */

import {
  loadDashboardLlmConfig,
  getEffectiveDashboardModel,
  resetDashboardLlmConfigCache,
} from "./llm-provider/config";
import type { DashboardLlmConfig } from "./llm-provider/types";

export type { DashboardLlmConfig };

export { resetDashboardLlmConfigCache };

/** Effective model id for the active provider (OpenRouter id or CLI `--model` value). */
export function getDashboardLlmModel(): string {
  return getEffectiveDashboardModel(loadDashboardLlmConfig());
}

/** Full config for admin / diagnostics (both backend models + provider). */
export function getDashboardLlmDisplayConfig(): DashboardLlmConfig {
  return loadDashboardLlmConfig();
}
