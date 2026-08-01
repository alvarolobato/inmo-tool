/**
 * Format a CliRunnerError into a user-facing message + a rich technical detail
 * block for the API "Detalles" modal. Spanish surface text; sanitized tails so
 * we never leak tokens or DSNs into the response (CliRunnerError.details
 * already carries sanitized stdout/stderr from sanitizeTail).
 *
 * The goal is that operators reading the modal know:
 *   - WHAT failed (inner code, exit code, phase, duration)
 *   - WHAT the CLI said on stdout/stderr (last 4 KB)
 *   - HOW TO FIX IT (remediation hint specific to the failure mode)
 *
 * The most common failure on a Mac dev machine is auth: the host's Keychain
 * token is expired (or the launchd snapshot fell behind). We give the exact
 * command sequence to recover.
 */

import { CliRunnerError } from "./errors";

export interface FormattedCliError {
  /** User-facing Spanish message including the remediation hint. */
  error: string;
  /** Multi-line Spanish technical detail block for the "Detalles" modal. */
  details: string;
  /** Inner CLI code (LLM_CLI_AUTH / LLM_CLI_EXIT / ...) for callers that want it. */
  innerCode: string;
}

/** Build the user-facing message + remediation for a given CliRunnerError code. */
function buildSurface(err: CliRunnerError, fallback: string): string {
  switch (err.code) {
    case "LLM_CLI_AUTH":
      return [
        "El CLI de Claude no está autenticado o el token ha caducado.",
        "Cómo solucionarlo:",
        "  1) En tu Mac (host), si el llavero sigue válido, ejecuta:",
        "       bash scripts/sync-claude-token.sh && ps stack restart",
        "  2) Si tras eso sigue fallando, vuelve a iniciar sesión en el host:",
        "       claude /login",
        "     y luego repite el paso 1.",
        "El contenedor nunca refresca el token por sí mismo (D-025) — la sincronización",
        "la hace el agente launchd cada 2h, pero un access_token caducado requiere acción manual.",
      ].join("\n");
    case "LLM_CLI_API_ERROR":
      return [
        "El CLI de Claude devolvió un error de la API.",
        "Si es un 5xx, reintenta en unos segundos. Si persiste, revisa el detalle abajo y consulta",
        "el estado del servicio Anthropic.",
      ].join("\n");
    case "LLM_CLI_TIMEOUT":
      return [
        "El CLI de Claude superó el tiempo máximo configurado.",
        "Cómo solucionarlo:",
        "  • Aumenta DASHBOARD_LLM_CLI_TIMEOUT_MS en config.yaml o en variables de entorno.",
        "  • Comprueba que el modelo configurado responde (DASHBOARD_LLM_MODEL_CLI).",
      ].join("\n");
    case "LLM_CLI_TRUNCATED":
      return [
        "La salida del CLI de Claude excedió el límite de captura.",
        "Aumenta DASHBOARD_LLM_CLI_MAX_CAPTURE_BYTES o reduce el tamaño del prompt.",
      ].join("\n");
    case "LLM_CLI_EMPTY":
      return [
        "El CLI de Claude terminó correctamente pero no devolvió ningún contenido.",
        "Reintenta. Si persiste, revisa los logs del contenedor dashboard.",
      ].join("\n");
    case "LLM_CLI_EXIT":
    default:
      return [
        fallback,
        "Revisa el detalle abajo (stdout/stderr) para ver qué dijo el CLI antes de salir.",
        "Las causas más habituales son token caducado (LLM_CLI_AUTH) o un fallo transitorio de la API.",
      ].join("\n");
  }
}

/** Build the multi-line technical detail block for the "Detalles" modal. */
function buildDetails(err: CliRunnerError): string {
  const d = err.details;
  const lines: string[] = [];
  lines.push(`Código interno: ${err.code}`);
  if (d.phase) lines.push(`Fase: ${d.phase}`);
  if (d.exitCode !== null && d.exitCode !== undefined) {
    lines.push(`Exit code: ${d.exitCode}`);
  }
  if (d.innerErrorCode !== null && d.innerErrorCode !== undefined) {
    lines.push(`API status interno: ${d.innerErrorCode}`);
  }
  if (typeof d.durationMs === "number") {
    lines.push(`Duración: ${d.durationMs}ms`);
  }
  if (d.command && d.command.length > 0) {
    lines.push(`Comando: ${d.command.join(" ")}`);
  }
  if (d.stderr && d.stderr.trim().length > 0) {
    lines.push("");
    lines.push("Stderr (último fragmento):");
    lines.push(d.stderr.trim());
  }
  if (d.stdout && d.stdout.trim().length > 0) {
    lines.push("");
    lines.push("Stdout (último fragmento):");
    lines.push(d.stdout.trim());
  }
  if (err.message && err.message.length > 0) {
    lines.push("");
    lines.push(`Mensaje: ${err.message}`);
  }
  return lines.join("\n");
}

/**
 * Convert a CliRunnerError into a structured response payload.
 *
 * @param err CliRunnerError instance.
 * @param fallbackError User-facing fallback when err.code does not have a
 *   tailored remediation message (defaults to a generic "Ocurrió un error con
 *   el CLI de Claude.").
 */
export function formatCliRunnerError(
  err: CliRunnerError,
  fallbackError: string = "Ocurrió un error al llamar al CLI de Claude.",
): FormattedCliError {
  return {
    error: buildSurface(err, fallbackError),
    details: buildDetails(err),
    innerCode: err.code,
  };
}

/** True when the value looks like a CliRunnerError (instanceof or shape). */
export function isCliRunnerError(value: unknown): value is CliRunnerError {
  if (value instanceof CliRunnerError) return true;
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    "details" in value &&
    typeof (value as { details: unknown }).details === "object"
  ) {
    return true;
  }
  return false;
}
