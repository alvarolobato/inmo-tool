"use client";

import { useState, useCallback, useEffect } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import { validateSpec } from "@/lib/schema";
import type { DashboardSpec } from "@/lib/schema";

interface SpecEditorProps {
  spec: DashboardSpec;
  onSave: (spec: DashboardSpec) => void;
  onClose: () => void;
}

export function SpecEditor({ spec, onSave, onClose }: SpecEditorProps) {
  const [code, setCode] = useState(() => JSON.stringify(spec, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reset saved indicator after 2s
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  const highlight = useCallback(
    (value: string) => Prism.highlight(value, Prism.languages.json, "json"),
    [],
  );

  const handleSave = useCallback(() => {
    setError(null);

    // 1. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(code);
    } catch (e) {
      const msg = e instanceof SyntaxError ? e.message : "JSON no válido";
      setError(`Error de sintaxis JSON: ${msg}`);
      return;
    }

    // 2. Validate with Zod schema
    try {
      const validated = validateSpec(parsed);
      onSave(validated);
      setSaved(true);
      setError(null);
    } catch (e) {
      if (e && typeof e === "object" && "issues" in e) {
        const issues = (e as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
        const details = issues
          .slice(0, 5)
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        setError(
          `El spec no es válido:\n${details}${issues.length > 5 ? `\n  ... y ${issues.length - 5} más` : ""}`,
        );
      } else {
        setError("El spec no es válido");
      }
    }
  }, [code, onSave]);

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(code);
      setCode(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      const msg = e instanceof SyntaxError ? e.message : "JSON no válido";
      setError(`Error de sintaxis JSON: ${msg}`);
    }
  }, [code]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
  }, [code]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-tremor-background dark:bg-dark-tremor-background rounded-tremor-default shadow-2xl ring-1 ring-tremor-ring dark:ring-dark-tremor-ring w-[90vw] max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-tremor-border dark:border-dark-tremor-border">
          <h2 className="text-tremor-title font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Editor de Fuente
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleFormat}
              className="rounded-tremor-default border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-tremor-default text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-muted dark:hover:bg-dark-tremor-background-subtle transition-colors"
            >
              Formatear
            </button>
            <button
              onClick={handleCopy}
              className="rounded-tremor-default border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-tremor-default text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-muted dark:hover:bg-dark-tremor-background-subtle transition-colors"
            >
              Copiar
            </button>
            <button
              onClick={handleSave}
              className="rounded-tremor-default px-4 py-1.5 text-tremor-default font-medium text-white hover:brightness-110 transition-all"
              style={{
                background: "var(--accent)",
                boxShadow: "0 8px 24px var(--accent-soft)",
              }}
            >
              {saved ? "Guardado!" : "Guardar"}
            </button>
            <button
              onClick={onClose}
              className="text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis text-xl leading-none ml-2"
              aria-label="Cerrar"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mt-4 rounded-tremor-default border border-red-500/30 bg-red-500/10 px-4 py-3">
            <pre className="text-tremor-default text-red-400 whitespace-pre-wrap font-mono">
              {error}
            </pre>
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-auto p-6">
          <Editor
            value={code}
            onValueChange={setCode}
            highlight={highlight}
            padding={16}
            className="font-mono text-sm rounded-tremor-default ring-1 ring-tremor-ring dark:ring-dark-tremor-ring bg-tremor-background-muted dark:bg-dark-tremor-background-muted min-h-[400px]"
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13,
              lineHeight: 1.6,
              minHeight: 400,
              color: "#e2e8f0",
              caretColor: "#60a5fa",
            }}
            textareaClassName="outline-none"
          />
        </div>
      </div>
    </div>
  );
}
