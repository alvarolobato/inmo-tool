"use client";

/**
 * GlossaryTooltip — lightweight CSS-only tooltip for glossary terms.
 *
 * Renders the `term` with a dotted underline. On hover or keyboard focus,
 * a tooltip popup appears above the term showing its `definition`.
 *
 * Styling:
 * - Light mode: dark background (bg-gray-900), white text
 * - Dark mode: light background (bg-gray-100), dark text
 * - Max-width 300px, positioned above the term, with a small caret
 *
 * No external tooltip library required — pure Tailwind CSS with group/peer.
 *
 * Accessibility:
 * - The term span has tabIndex=0 so it is keyboard focusable.
 * - The tooltip span has role="tooltip" and id matching the term's aria-describedby.
 * - This correctly announces the definition via aria-describedby on focus/hover.
 */

import { useId } from "react";

interface GlossaryTooltipProps {
  term: string;
  definition: string;
}

export function GlossaryTooltip({ term, definition }: GlossaryTooltipProps) {
  const tooltipId = useId();

  return (
    <span className="relative inline-block group">
      {/* The underlined term — focusable text, not a button */}
      <span
        className="decoration-dotted underline underline-offset-2 cursor-help text-inherit"
        tabIndex={0}
        aria-describedby={tooltipId}
      >
        {term}
      </span>

      {/* Tooltip popup — visible on group-hover and group-focus-within */}
      <span
        id={tooltipId}
        role="tooltip"
        className={[
          // Positioning: above the term, centred
          "pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50",
          // Visibility: hidden by default, shown on hover/focus
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          "transition-opacity duration-150",
          // Layout
          "w-max max-w-[300px] px-3 py-2 rounded-lg",
          // Light/dark colours
          "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
          "text-xs font-normal leading-snug",
          "shadow-lg",
          // Prevent text wrapping to be too wide
          "whitespace-normal break-words",
        ].join(" ")}
      >
        {definition}

        {/* Down-pointing caret */}
        <span
          aria-hidden="true"
          className={[
            "absolute top-full left-1/2 -translate-x-1/2",
            "border-4 border-transparent",
            "border-t-gray-900 dark:border-t-gray-100",
          ].join(" ")}
        />
      </span>
    </span>
  );
}
