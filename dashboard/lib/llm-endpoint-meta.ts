/**
 * Spanish labels for `llm_usage.endpoint` keys (see `logUsage` in `lib/llm.ts`).
 * Used in admin usage UI and API aggregates so historical rows stay readable.
 */

export interface LlmEndpointMetaEs {
  /** Short title for tables and cards */
  label: string;
  /** One or two sentences: what triggered the LLM call */
  detail: string;
}

const DEFAULT_META: LlmEndpointMetaEs = {
  label: "Otro",
  detail: "Uso del modelo registrado con una clave no catalogada.",
};

const MAP: Record<string, LlmEndpointMetaEs> = {
  generateDashboard: {
    label: "Generar dashboard",
    detail:
      "Construye un cuadro de mandos nuevo desde lenguaje natural: tareas predefinidas, sugerencias por rol, huecos de cobertura o descripción libre.",
  },
  modifyDashboard: {
    label: "Modificar dashboard",
    detail:
      "Aplica cambios al JSON del dashboard existente según instrucciones del usuario (editor de cuadro de mando).",
  },
  suggestDashboards: {
    label: "Sugerir dashboards por rol",
    detail:
      "Propone varios paneles útiles para un rol concreto, evitando solaparse con los dashboards que ya existen.",
  },
  analyzeGaps: {
    label: "Analizar huecos de cobertura",
    detail:
      "Revisa los dashboards guardados (títulos y widgets) e identifica áreas de negocio que faltan o están poco cubiertas.",
  },
  analyzeDashboard: {
    label: "Analizar datos del dashboard",
    detail:
      "Responde en lenguaje natural a preguntas sobre los datos ya cargados en los widgets del cuadro de mando.",
  },
  generateReview: {
    label: "Revisión semanal (IA)",
    detail:
      "Genera el informe semanal de negocio a partir de los resultados de las consultas SQL de revisión.",
  },
  generateSuggestions: {
    label: "Sugerencias de seguimiento",
    detail:
      "Propone preguntas cortas de seguimiento en el chat de análisis del dashboard, a partir del último intercambio.",
  },
};

export function getLlmEndpointMetaEs(endpoint: string): LlmEndpointMetaEs {
  const m = MAP[endpoint];
  if (m) return m;
  return {
    label: DEFAULT_META.label,
    detail: `${DEFAULT_META.detail} Clave técnica: ${endpoint}.`,
  };
}
