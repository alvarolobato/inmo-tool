"use client";

export interface RevisionChip {
  id: number;
  revision: number;
  generation_mode: string;
  created_at: string;
}

export interface ReviewRevisionTimelineProps {
  revisions: RevisionChip[];
  selectedId: number;
  onSelect: (id: number) => void;
}

export function ReviewRevisionTimeline({
  revisions,
  selectedId,
  onSelect,
}: ReviewRevisionTimelineProps) {
  if (revisions.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2 items-center" data-testid="revision-timeline">
      <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
        Versiones:
      </span>
      {revisions.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onSelect(r.id)}
          style={
            r.id === selectedId
              ? {
                  border: "1px solid var(--accent)",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  borderRadius: 9999,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }
              : {
                  border: "1px solid var(--border-strong)",
                  background: "transparent",
                  color: "var(--fg-muted)",
                  borderRadius: 9999,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }
          }
          data-testid={`revision-chip-${r.revision}`}
        >
          v{r.revision} ({r.generation_mode})
        </button>
      ))}
    </div>
  );
}
