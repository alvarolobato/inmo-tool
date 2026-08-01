import { NextResponse } from "next/server";
import { loadDashboardLlmConfig, getEffectiveDashboardModel } from "@/lib/llm-provider/config";

export function GET() {
  const model = getEffectiveDashboardModel(loadDashboardLlmConfig());
  return NextResponse.json({ model });
}
