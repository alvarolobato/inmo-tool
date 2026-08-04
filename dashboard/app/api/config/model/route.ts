import { NextResponse } from "next/server";
import { loadDashboardLlmConfig, getEffectiveDashboardModel } from "@/lib/llm-provider/config";

// Reads the runtime-mounted config schema (config/schema.yaml is bind-mounted at
// runtime and is absent during `docker build`); never prerender this at build.
export const dynamic = "force-dynamic";

export function GET() {
  const model = getEffectiveDashboardModel(loadDashboardLlmConfig());
  return NextResponse.json({ model });
}
