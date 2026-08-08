// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Modal } from "../Modal";

function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <Modal open title="Editar perfil" onClose={onClose} {...props}>
      <input data-testid="first-field" />
      <button>Guardar</button>
    </Modal>,
  );
  return { onClose };
}

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal open={false} title="x" onClose={vi.fn()}>
        <input />
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders an accessible dialog with the title", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Editar perfil" })).toBeInTheDocument();
  });

  // Autofocus (rAF-driven) is asserted in the real browser via
  // e2e/profile-edit-modal.spec.ts — jsdom does not reliably run rAF + focus.

  it("closes on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape or backdrop while busy", () => {
    const onClose = vi.fn();
    renderModal({ onClose, busy: true });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the provided testId for the panel and backdrop", () => {
    renderModal({ testId: "profile-edit-modal" });
    expect(screen.getByTestId("profile-edit-modal")).toBeInTheDocument();
    expect(screen.getByTestId("profile-edit-modal-backdrop")).toBeInTheDocument();
  });

  // #459: the panel must sit on a different surface token than the inputs it
  // contains. Form inputs use --bg-2 (see ProfileForm); the panel uses --bg-1
  // so fields read as distinct, recessed boxes in both light and dark themes
  // instead of blending into the panel (which was also --bg-2 before #459).
  it("gives the panel a surface (--bg-1) distinct from the --bg-2 inputs", () => {
    renderModal();
    const panel = screen.getByRole("dialog");
    const inputSurface = "var(--bg-2)"; // the token ProfileForm uses for inputs
    expect(panel).toHaveStyle({ background: "var(--bg-1)" });
    expect(panel.style.background).not.toBe(inputSurface);
  });

  // #459: the modal was widened. Default panel width tracks the wider max.
  it("uses the widened default max width", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toHaveStyle({
      width: "min(640px, 95vw)",
    });
  });

  it("honors a custom maxWidth override", () => {
    renderModal({ maxWidth: 700 });
    expect(screen.getByRole("dialog")).toHaveStyle({
      width: "min(700px, 95vw)",
    });
  });
});
