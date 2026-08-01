/**
 * Best-effort sanitization for LLM/CLI diagnostic strings shown in API
 * responses, log lines, and the "Detalles" modal.
 *
 * Goal: never leak `CLAUDE_CODE_OAUTH_TOKEN`, `OPENROUTER_API_KEY`, the
 * contents of `~/.claude/.credentials.json`, JWT-shaped strings, or
 * Authorization headers — even if the upstream CLI happens to print them.
 *
 * This is an authoring-time safety net. Authoritative redaction still
 * lives in `errors.ts > sanitizeErrorMessage` for short string details,
 * but `sanitize()` accepts long multi-line strings (stdout/stderr tails)
 * and applies a broader pattern set without truncating to 300 chars.
 */

import { getSystemConfig } from "@/lib/system-config/loader";

const REDACTED = "[redacted]";

// Regular expressions ordered roughly by specificity → generality.
// Each captures one occurrence; `replaceAll` semantics rely on `g` flag.
//
// IMPORTANT: when using a capture group in the replacement, reference it as
// `$1`/`$2`/etc. NEVER use `$&` (the full match) — that would echo the
// secret value back into the output and defeat the redaction.
const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Authorization header with Basic/Token/Bearer/Digest scheme prefix:
  // capture the scheme keyword and replace the value with `[redacted]`.
  // Match the value as one-or-more non-whitespace tokens that don't start
  // with `[` (so we don't re-match an already-redacted line on idempotent
  // runs) and stop at comma/quote so structured logs (`Authorization: Basic
  // dXNlcjpwYXNz, X-Other: …`) don't bleed across headers. Run BEFORE the
  // standalone `Bearer …` rule so the scheme is preserved, and BEFORE the
  // catch-all so we keep the scheme name visible.
  {
    re: /\bAuthorization\s*:\s*(Bearer|Basic|Token|Digest)\s+(?!\[)[^\s,"\r\n]+/gi,
    replacement: "Authorization: $1 " + REDACTED,
  },
  // OAuth bearer tokens outside an Authorization header (`token=Bearer xyz`).
  { re: /\bBearer\s+(?!\[)[A-Za-z0-9._\-+/=]{8,}/gi, replacement: "Bearer " + REDACTED },
  // Authorization header without a recognised scheme keyword — fully redact.
  // Skip values that already start with `[` so idempotent runs don't churn.
  {
    re: /\bAuthorization\s*:\s*(?!Bearer\b|Basic\b|Token\b|Digest\b|\[)[^\s",]+/gi,
    replacement: "Authorization: " + REDACTED,
  },
  // Anthropic CLI long-lived OAuth tokens often start with `sk-ant-` —
  // match BEFORE the generic `sk-…` rule so the longer prefix wins.
  { re: /\bsk-ant-[A-Za-z0-9_\-]{8,}/g, replacement: REDACTED },
  // OpenAI / OpenRouter style keys: sk-... (>= 16 chars after the prefix).
  { re: /\bsk-[A-Za-z0-9_\-]{16,}/g, replacement: REDACTED },
  // JWT-shaped strings: 3 base64url segments separated by `.`, each at least 8 chars.
  { re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, replacement: REDACTED },
  // PostgreSQL DSN.
  { re: /postgres(?:ql)?:\/\/[^\s'"<>]*/gi, replacement: "postgres://" + REDACTED },
  // user:pass@host pattern (covers DSN-style basic auth too).
  { re: /:[^@\s'"]+@/g, replacement: ":" + REDACTED + "@" },
  // password=... (query string / log dump form).
  { re: /password\s*=\s*[^\s&'"]+/gi, replacement: "password=" + REDACTED },
  // refresh_token / access_token JSON values: capture the key and emit
  // `"key": "[redacted]"`. Using `$1` is critical — `$&` would re-emit the
  // full match (including the secret) into the output.
  {
    re: /"(refresh_token|access_token|refreshToken|accessToken)"\s*:\s*"[^"]*"/g,
    replacement: `"$1": "${REDACTED}"`,
  },
];

/**
 * Build the runtime list of sensitive env-var literal values to scrub.
 *
 * We pull the live values for every key marked `sensitive: true` in
 * `config/schema.yaml` and strip any non-empty value from the input.
 * If the loader fails (tests, config missing), we silently fall back
 * to the regex-only pass.
 */
function getSensitiveLiterals(): string[] {
  try {
    const cfg = getSystemConfig();
    const out: string[] = [];
    for (const v of Object.values(cfg)) {
      if (!v.sensitive) continue;
      const raw = v.value;
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      // Avoid scrubbing trivially short / placeholder values that would
      // create huge collateral damage on the redacted output.
      if (trimmed.length >= 8) out.push(trimmed);
    }
    return out;
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitize a free-form diagnostic string. Returns a new string with
 * known-secret patterns replaced by `[redacted]`. Idempotent: running
 * twice yields the same output.
 */
export function sanitize(input: string | null | undefined): string {
  if (!input) return "";
  let out = String(input);
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  for (const literal of getSensitiveLiterals()) {
    if (!literal) continue;
    out = out.replace(new RegExp(escapeRegExp(literal), "g"), REDACTED);
  }
  return out;
}

/**
 * Sanitize then keep the trailing `maxBytes` (UTF-8). Useful for stderr
 * tails — the recent end of the buffer is usually where the actual
 * failure shows up.
 */
export function sanitizeTail(input: string | null | undefined, maxBytes: number): string {
  const cleaned = sanitize(input);
  if (cleaned.length <= maxBytes) return cleaned;
  // Trim to the last maxBytes characters; we don't byte-count here as
  // diagnostic strings are virtually always single-byte ASCII / latin1.
  return cleaned.slice(cleaned.length - maxBytes);
}

/**
 * Sanitize an argv array for display. Hides values right after flags
 * known to carry credentials (e.g. `--api-key`, `--token`).
 */
const FLAG_VALUE_REDACT = new Set([
  "--api-key",
  "--token",
  "--auth-token",
  "--bearer",
  "--password",
  "--secret",
]);

/**
 * Flags whose value is free-form prompt content. We always pass the
 * sanitized value through — secrets in user prompts (rare but possible)
 * are caught by the regex set, and overlong prompts are truncated to
 * keep the displayed argv readable.
 */
const FLAG_PROMPT_LIKE = new Set(["-p", "--prompt", "--system", "--system-prompt"]);
const PROMPT_DISPLAY_LIMIT = 240;

export function sanitizeArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    out.push(sanitize(a));
    if (i + 1 >= argv.length) continue;
    if (FLAG_VALUE_REDACT.has(a)) {
      out.push(REDACTED);
      i += 1;
    } else if (FLAG_PROMPT_LIKE.has(a)) {
      const next = sanitize(argv[i + 1]);
      out.push(
        next.length > PROMPT_DISPLAY_LIMIT
          ? next.slice(0, PROMPT_DISPLAY_LIMIT) + "…[truncated]"
          : next,
      );
      i += 1;
    }
  }
  return out;
}
