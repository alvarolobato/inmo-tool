"use client";

/**
 * Render the rich AgenticErrorDiagnostic shipped on AGENTIC_RUNNER errors.
 *
 * Sections (in order):
 *   - Causa     code · subError
 *   - Contexto  provider · driver · model · phase · duración · rondas usadas
 *   - CLI       exit code · command · stderr tail · stdout tail (only when provider=cli)
 *   - Tool      lastToolCall (when present)
 *   - Límites   maxRounds, maxToolCalls, toolTimeoutMs, executeRowLimit, payloadCharLimit
 *
 * The component is read-only and intentionally renders sanitized strings as-is
 * inside `<pre>` so multiline tails stay readable.
 */

import type { ApiErrorResponse, AgenticErrorDiagnostic } from "@/lib/errors";

interface Props {
  errorDetail: ApiErrorResponse;
  /**
   * When true, omit the duplicated `code`/`requestId` rows because the parent
   * already renders them (e.g. ErrorDisplay's header). Default: false (used by
   * the chat sidebar where there is no separate header).
   */
  skipHeader?: boolean;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="font-semibold whitespace-nowrap">{label}:</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-0.5" data-testid={testId}>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-red-200/70">{title}</p>
      {children}
    </div>
  );
}

export default function AgenticErrorDetails({ errorDetail, skipHeader = false }: Props) {
  const d: AgenticErrorDiagnostic | undefined = errorDetail.diagnostic;

  // When there is no diagnostic AND no extra details to render, we still
  // want to surface the legacy `details` string. But if the parent already
  // renders code/requestId/details (skipHeader=true) and there is nothing
  // diagnostic-specific, we render nothing to avoid duplicate rows.
  if (skipHeader && !d) return null;

  return (
    <div
      className="mt-1 rounded bg-red-900/20 p-2 text-xs font-mono space-y-1 text-red-300"
      data-testid="agentic-error-details"
    >
      {!skipHeader && (
        <Section title="Causa" testId="ae-section-causa">
          <Row label="Código" value={errorDetail.code} />
          <Row label="ID" value={errorDetail.requestId} />
          {d?.subError && (
            <Row
              label="subError"
              value={<span className="whitespace-pre-wrap">{d.subError}</span>}
            />
          )}
          {!d && errorDetail.details && (
            <Row
              label="Detalle"
              value={<span className="whitespace-pre-wrap">{errorDetail.details}</span>}
            />
          )}
        </Section>
      )}
      {skipHeader && d?.subError && (
        <Section title="Causa" testId="ae-section-causa">
          <Row
            label="subError"
            value={<span className="whitespace-pre-wrap">{d.subError}</span>}
          />
        </Section>
      )}

      {d && (
        <Section title="Contexto" testId="ae-section-contexto">
          <Row label="provider" value={d.provider} />
          <Row label="driver" value={d.driver ?? "—"} />
          <Row label="model" value={d.model} />
          <Row label="phase" value={d.phase} />
          <Row label="durationMs" value={String(d.durationMs)} />
          <Row label="toolRoundsUsed" value={String(d.toolRoundsUsed)} />
          <Row label="toolCallsUsed" value={String(d.toolCallsUsed)} />
        </Section>
      )}

      {d?.cli && (
        <Section title="CLI" testId="ae-section-cli">
          <Row label="exitCode" value={String(d.cli.exitCode ?? "—")} />
          {d.cli.innerErrorCode != null && (
            <Row label="innerErrorCode" value={String(d.cli.innerErrorCode)} />
          )}
          {d.cli.command && d.cli.command.length > 0 && (
            <div>
              <span className="font-semibold">command:</span>
              <pre className="mt-0.5 whitespace-pre-wrap break-all text-red-300/90">
                {d.cli.command.join(" ")}
              </pre>
            </div>
          )}
          {d.cli.stderrTail && (
            <div>
              <span className="font-semibold">stderr (tail):</span>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-1 text-red-200/90">
                {d.cli.stderrTail}
              </pre>
            </div>
          )}
          {d.cli.stdoutTail && (
            <div>
              <span className="font-semibold">stdout (tail):</span>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-1 text-red-200/90">
                {d.cli.stdoutTail}
              </pre>
            </div>
          )}
        </Section>
      )}

      {d?.lastToolCall && (
        <Section title="Tool en curso" testId="ae-section-tool">
          <Row label="name" value={d.lastToolCall.name} />
          <Row
            label="arguments"
            value={
              <span className="whitespace-pre-wrap">{d.lastToolCall.argumentsTruncated}</span>
            }
          />
        </Section>
      )}

      {d?.limitsAtFailure && (
        <Section title="Límites" testId="ae-section-limites">
          <Row label="maxRounds" value={String(d.limitsAtFailure.maxRounds)} />
          <Row label="maxToolCalls" value={String(d.limitsAtFailure.maxToolCalls)} />
          <Row label="toolTimeoutMs" value={String(d.limitsAtFailure.toolTimeoutMs)} />
          <Row label="executeRowLimit" value={String(d.limitsAtFailure.executeRowLimit)} />
          <Row label="payloadCharLimit" value={String(d.limitsAtFailure.payloadCharLimit)} />
        </Section>
      )}
    </div>
  );
}
