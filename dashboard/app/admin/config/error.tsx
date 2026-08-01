"use client";

/**
 * Error boundary for /admin/config.
 *
 * Next.js renders this component whenever the page or any server component
 * in this route segment throws. Without this file Next.js falls back to a
 * bare "Error 500" page with no details.
 */

import { useEffect } from "react";
import ErrorDisplay from "@/components/ErrorDisplay";
import type { ApiErrorResponse } from "@/lib/errors";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AdminConfigError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[/admin/config] Page error:", error);
  }, [error]);

  // Try to surface as much detail as possible. The error may carry a Next.js
  // digest (an opaque server-side hash), or the message may be the raw throw.
  const structured: ApiErrorResponse = {
    error: error.message || "Error al cargar la página de configuración.",
    code: "UNKNOWN",
    details: error.digest ? `digest: ${error.digest}` : undefined,
    timestamp: new Date().toISOString(),
    requestId: error.digest ?? "server-render",
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <ErrorDisplay
        error={structured}
        title="Error al cargar Configuración"
        onRetry={reset}
      />
    </div>
  );
}
