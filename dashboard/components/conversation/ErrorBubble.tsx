"use client";

import { useState, useRef, useEffect } from "react";
import type { ApiErrorResponse } from "@/lib/errors";
import AgenticErrorDetails from "@/components/AgenticErrorDetails";

// ---------------------------------------------------------------------------
// ErrorBubble — expandable error detail inside a chat message
// ---------------------------------------------------------------------------

export function ErrorBubble({
  message,
  errorDetail,
}: {
  message: string;
  errorDetail?: ApiErrorResponse;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(errorDetail, null, 2));
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="text-sm text-red-400">
      <p>{message}</p>
      {errorDetail && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setExpanded((p) => !p)}
            className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
            aria-expanded={expanded}
            data-testid="chat-toggle-details"
          >
            <span
              style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
              className="inline-block transition-transform"
              aria-hidden="true"
            >
              &#9656;
            </span>
            Detalles técnicos
          </button>
          {expanded && (
            <div data-testid="chat-error-details">
              <AgenticErrorDetails errorDetail={errorDetail} />
              <button
                type="button"
                onClick={handleCopy}
                className="mt-1 text-xs text-red-400 hover:text-red-300 underline"
                data-testid="copy-as-json"
              >
                {copied ? "Copiado!" : "Copiar como JSON"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
