"use client";

import { PROFILE_TEMPLATES } from "@/lib/profile-templates";

interface TemplatePickerProps {
  /** Currently-selected template id, or null for the blank ("Empezar en blanco") start. */
  selectedId: string | null;
  /** Called with a template id when a template is chosen, or null for "Empezar en blanco". */
  onPick: (id: string | null) => void;
}

/**
 * Template chooser shown ABOVE the (always-rendered) ProfileForm in the create
 * flow (issue #39). Picking a template pre-fills the form with that thesis's
 * plausible defaults — it does NOT lock anything: the investor edits every
 * field afterwards, and "Empezar en blanco" keeps the original blank flow
 * (task 2.3) exactly as it was (EC-3).
 *
 * It only chooses which starting values seed the form (the parent remounts
 * ProfileForm with a new `key`/`initial`); it never submits or validates —
 * that stays entirely with ProfileForm and POST /api/profiles. No schema.
 */
export function TemplatePicker({ selectedId, onPick }: TemplatePickerProps) {
  return (
    <div data-testid="template-picker" style={{ marginBottom: 16 }}>
      <p
        style={{
          margin: "0 0 4px",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--fg)",
        }}
      >
        Empieza desde una plantilla
      </p>
      <p
        style={{ margin: "0 0 10px", fontSize: 12, color: "var(--fg-subtle)" }}
      >
        Elige una tesis para rellenar el formulario con valores de partida
        sensatos. Podrás editarlo todo antes de guardar.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {PROFILE_TEMPLATES.map((tpl) => {
          const active = selectedId === tpl.id;
          return (
            <button
              key={tpl.id}
              type="button"
              data-testid={`template-option-${tpl.id}`}
              aria-pressed={active}
              onClick={() => onPick(tpl.id)}
              title={tpl.description}
              style={{
                flex: "1 1 180px",
                minWidth: 160,
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "var(--bg-2)" : "var(--bg-1)",
                color: "var(--fg)",
                cursor: "pointer",
                boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
              }}
            >
              <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                {tpl.label}
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--fg-subtle)",
                }}
              >
                {tpl.description}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          data-testid="template-option-blank"
          aria-pressed={selectedId === null}
          onClick={() => onPick(null)}
          style={{
            flex: "1 1 180px",
            minWidth: 160,
            textAlign: "left",
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${selectedId === null ? "var(--accent)" : "var(--border)"}`,
            background: selectedId === null ? "var(--bg-2)" : "var(--bg-1)",
            color: "var(--fg)",
            cursor: "pointer",
            boxShadow: selectedId === null ? "0 0 0 1px var(--accent)" : "none",
          }}
        >
          <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
            Empezar en blanco
          </span>
          <span
            style={{
              display: "block",
              marginTop: 3,
              fontSize: 11,
              lineHeight: 1.35,
              color: "var(--fg-subtle)",
            }}
          >
            Formulario vacío con los valores por defecto de siempre.
          </span>
        </button>
      </div>
    </div>
  );
}
