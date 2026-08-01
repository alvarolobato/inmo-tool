/**
 * Shared JSON extraction utility for LLM responses.
 *
 * LLM responses are expected to be raw JSON, but models sometimes wrap
 * the output in markdown code fences or add surrounding text.  This
 * module provides a reusable extraction function so the unfencing
 * behaviour can stay consistent wherever it is needed.
 *
 * Note: the generate/modify routes currently keep their own local copy of
 * this helper.  Those copies can be migrated to import from here in a
 * future cleanup pass.
 */

/**
 * Extract JSON from an LLM response that may be wrapped in markdown code blocks.
 *
 * Handles:
 *   - Clean raw JSON (returned as-is after trimming)
 *   - Fully-anchored fenced block:  ```json\n...\n```
 *   - Partial fenced block with surrounding text (e.g. introductory sentence)
 *
 * @param raw - Raw LLM response string
 * @returns String suitable for JSON.parse()
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // Try fully-anchored fence first (cleanest response).
  // Use /i so ```JSON``` or ```Json``` variants are handled the same way.
  const fullFenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fullFenceMatch) {
    return fullFenceMatch[1].trim();
  }

  // Try non-anchored: extract first fenced block even when there is surrounding text
  const partialFenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (partialFenceMatch) {
    return partialFenceMatch[1].trim();
  }

  return trimmed;
}
