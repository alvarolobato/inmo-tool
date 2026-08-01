/**
 * GET /api/health — Liveness check for Docker healthcheck.
 *
 * Returns 200 with `{ status: "ok", llm_circuit: ... }` where `llm_circuit` is the
 * dashboard LLM circuit breaker state (`closed` | `open` | `half-open`).
 */
import { NextResponse } from "next/server";
import { getCircuitState } from "@/lib/llm-circuit-breaker";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: "ok", llm_circuit: getCircuitState() });
}
