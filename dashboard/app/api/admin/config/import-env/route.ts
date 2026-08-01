/**
 * POST /api/admin/config/import-env
 *
 * Copies all keys that currently come from environment variables into
 * config.yaml, so the admin can later remove the env vars and rely on the file.
 *
 * Returns the list of keys that were imported.
 * Requires admin authentication.
 */

import { NextRequest, NextResponse } from "next/server";

import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { importEnvToConfig } from "@/lib/system-config/loader";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let imported: string[];
  try {
    imported = importEnvToConfig();
  } catch (err) {
    console.error("[config import-env] Failed to write config:", err);
    return NextResponse.json({ error: "Failed to write config file" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    imported,
    count: imported.length,
    message:
      imported.length > 0
        ? `Se importaron ${imported.length} variables de entorno al fichero de configuración. ` +
          "Las variables de entorno siguen teniendo prioridad hasta que las elimines del entorno."
        : "No hay variables de entorno activas para importar.",
  });
}
