"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// AnalyzeLauncher — floating right rail "Analizar con IA"
//
// Clicking the button opens the chat sidebar in analyze mode with a seeded
// prompt. The sidebar itself handles conversation creation lazily when the
// user sends their first message — this component no longer creates a
// conversation or navigates away, which avoids:
//   - A new conversation being created on every click
//   - The user being navigated away from the dashboard (/k/ 404)
//
// Visible when chat sidebar is closed; hidden when open.
// ---------------------------------------------------------------------------

interface AnalyzeLauncherProps {
  /** Numeric dashboard id — kept for API compatibility */
  dashboardId?: number | null;
  /** When true the rail is hidden (sidebar is already open) */
  hidden?: boolean;
  /** Called when the user clicks — should open the chat sidebar in analyze mode */
  onOpen?: (seedPrompt: string) => void;
}

export default function AnalyzeLauncher({
  hidden = false,
  onOpen,
}: AnalyzeLauncherProps) {
  const [hover, setHover] = useState(false);

  if (hidden) return null;

  function handleClick() {
    if (onOpen) {
      onOpen("");
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Analizar con IA"
      aria-label="Analizar con IA"
      data-testid="analyze-launcher"
      style={{
        position: "fixed",
        right: 0,
        top: "42%",
        zIndex: 14,
        width: 36,
        background: "var(--accent)",
        color: "#fff",
        border: "none",
        padding: "16px 0",
        borderTopLeftRadius: 10,
        borderBottomLeftRadius: 10,
        cursor: "pointer",
        writingMode: "vertical-rl",
        transform: "rotate(180deg)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.04em",
        boxShadow: "0 8px 24px var(--accent-soft)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: "inherit",
        filter: hover ? "brightness(1.1)" : undefined,
        transition: "filter 120ms, background 120ms",
      }}
    >
      <span style={{ transform: "rotate(180deg)", display: "inline-block" }}>✦</span>
      <span>Analizar con IA</span>
    </button>
  );
}
