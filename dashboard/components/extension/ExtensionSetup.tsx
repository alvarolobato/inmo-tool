"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@tremor/react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";

/**
 * Extension setup content (issue #256, extracted in #509).
 *
 * The three setup jobs — download the packaged extension, copy the dashboard's
 * own origin (the "API URL"), copy ADMIN_API_KEY — rendered as a self-contained
 * block so it can live BOTH on the full-page `/etl/extension` route AND inside
 * the inline `<ExtensionCta/>` modal. Nothing here changed from the original
 * page (#509 explicitly keeps the setup steps identical); it just no longer owns
 * its own admin tab.
 *
 * Client-side so the API URL can be read from `window.location.origin` (exactly
 * what the operator pastes into the extension options).
 */

const DOWNLOAD_HREF = "/api/extension/download";

// ─── Small building blocks ──────────────────────────────────────────────────

function CopyButton({
  value,
  testId,
  disabled,
}: {
  value: string;
  testId: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked (insecure context / permissions). Fall back
      // to selecting the text so the operator can copy manually — never throw.
      setCopied(false);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={disabled || !value}
      data-testid={testId}
      className="shrink-0 rounded-md border border-tremor-border px-3 py-1.5 text-sm font-medium text-tremor-content-strong transition hover:bg-tremor-background-muted disabled:cursor-not-allowed disabled:opacity-50 dark:border-dark-tremor-border dark:text-dark-tremor-content-strong dark:hover:bg-dark-tremor-background-muted"
    >
      {copied ? "Copiado ✓" : "Copiar"}
    </button>
  );
}

function ValueRow({
  value,
  mono = true,
  testId,
}: {
  value: string;
  mono?: boolean;
  testId: string;
}) {
  return (
    <code
      data-testid={testId}
      className={`flex-1 truncate rounded-md bg-tremor-background-muted px-3 py-1.5 text-sm text-tremor-content-strong dark:bg-dark-tremor-background-muted dark:text-dark-tremor-content-strong ${
        mono ? "font-mono" : ""
      }`}
    >
      {value}
    </code>
  );
}

// ─── Setup block ─────────────────────────────────────────────────────────────

export function ExtensionSetup() {
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<ApiErrorResponse | string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // API URL is whatever origin the operator is viewing this on — that's
  // precisely the value the extension must call. Read on the client only.
  useEffect(() => {
    setApiUrl(window.location.origin);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/extension/key");
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (!cancelled) {
            setKeyError(
              isApiErrorResponse(body) ? body : "No se pudo obtener la clave de API",
            );
          }
          return;
        }
        const body = await res.json();
        if (!cancelled) setApiKey(typeof body.key === "string" ? body.key : "");
      } catch (err) {
        if (!cancelled) {
          setKeyError(err instanceof Error ? err.message : "No se pudo obtener la clave de API");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const maskedKey = apiKey
    ? revealed
      ? apiKey
      : "•".repeat(Math.min(apiKey.length, 40))
    : "";

  return (
    <div data-testid="extension-setup" className="space-y-6">
      {/* ── 1. Download ─────────────────────────────────────────────────── */}
      <Card className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            1. Descargar la extensión
          </h2>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Descarga el paquete y descomprímelo en una carpeta estable (no la borres: Chrome la
            lee cada vez que arranca).
          </p>
        </div>

        <a
          href={DOWNLOAD_HREF}
          download
          data-testid="extension-download-btn"
          className="inline-flex items-center gap-2 rounded-md bg-tremor-brand px-4 py-2 text-sm font-medium text-tremor-brand-inverted transition hover:bg-tremor-brand-emphasis"
        >
          ⬇ Descargar inmo-tool-extension.zip
        </a>

        <ol className="list-decimal space-y-1 pl-5 text-sm text-tremor-content dark:text-dark-tremor-content">
          <li>Descomprime el .zip en una carpeta permanente.</li>
          <li>
            Abre <code className="font-mono">chrome://extensions</code> en Chrome.
          </li>
          <li>
            Activa <strong>Modo de desarrollador</strong> (arriba a la derecha).
          </li>
          <li>
            Pulsa <strong>Cargar descomprimida</strong> y selecciona la carpeta descomprimida
            (la que contiene <code className="font-mono">manifest.json</code>).
          </li>
          <li>Abre las opciones de la extensión y pega los dos valores de abajo.</li>
        </ol>

        <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          Si el botón de descarga no funciona (paquete no incluido en esta build), carga
          directamente la carpeta <code className="font-mono">browser-extension/</code> del
          repositorio.
        </p>
      </Card>

      {/* ── 2. API URL ──────────────────────────────────────────────────── */}
      <Card className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            2. URL de la API
          </h2>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Pégala en el campo <strong>API URL</strong> de las opciones de la extensión.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ValueRow value={apiUrl} testId="extension-api-url" />
          <CopyButton value={apiUrl} testId="extension-api-url-copy" disabled={!apiUrl} />
        </div>
      </Card>

      {/* ── 3. API key ──────────────────────────────────────────────────── */}
      <Card className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            3. Clave de API
          </h2>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Pégala en el campo <strong>API key</strong> de las opciones de la extensión. Trátala
            como una contraseña.
          </p>
        </div>

        {keyError ? (
          <ErrorDisplay error={keyError} />
        ) : (
          <div className="flex items-center gap-2">
            <ValueRow
              value={apiKey === null ? "Cargando…" : maskedKey}
              testId="extension-api-key"
            />
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              disabled={!apiKey}
              data-testid="extension-api-key-reveal"
              className="shrink-0 rounded-md border border-tremor-border px-3 py-1.5 text-sm font-medium text-tremor-content-strong transition hover:bg-tremor-background-muted disabled:cursor-not-allowed disabled:opacity-50 dark:border-dark-tremor-border dark:text-dark-tremor-content-strong dark:hover:bg-dark-tremor-background-muted"
            >
              {revealed ? "Ocultar" : "Mostrar"}
            </button>
            <CopyButton
              value={apiKey ?? ""}
              testId="extension-api-key-copy"
              disabled={!apiKey}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
