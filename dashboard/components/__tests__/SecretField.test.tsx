// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import SecretField from "../SecretField";

describe("SecretField", () => {
  it("renders as type=password by default", () => {
    render(<SecretField value="secret-value" />);
    // password inputs are not in the accessibility tree as "textbox"
    const el = document.querySelector("input") as HTMLInputElement | null;
    expect(el).not.toBeNull();
    expect(el!.type).toBe("password");
  });

  it("shows masked value when not revealed", () => {
    render(<SecretField value="••••1234" />);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("••••1234");
  });

  it("does not expose real value in DOM when hidden", () => {
    render(<SecretField value="••••1234" revealed="actual-secret-value" />);
    const input = document.querySelector("input") as HTMLInputElement;
    // When not revealed, the masked value should show, type=password
    expect(input.type).toBe("password");
    expect(input.value).toBe("••••1234");
  });

  it("reveals value when eye button clicked (with revealed prop)", async () => {
    render(<SecretField value="••••1234" revealed="actual-secret-value" />);
    const eyeBtn = screen.getByTitle("Mostrar valor");
    fireEvent.click(eyeBtn);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("actual-secret-value");
  });

  it("hides value again when eye button clicked a second time", () => {
    render(<SecretField value="••••1234" revealed="actual-secret-value" />);
    const eyeBtn = screen.getByTitle("Mostrar valor");
    fireEvent.click(eyeBtn);
    const hideBtn = screen.getByTitle("Ocultar");
    fireEvent.click(hideBtn);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("••••1234");
  });

  it("calls onReveal when revealing and no revealed value yet", async () => {
    const onReveal = vi.fn().mockResolvedValue(undefined);
    render(<SecretField value="••••" onReveal={onReveal} />);
    const eyeBtn = screen.getByTitle("Mostrar valor");
    fireEvent.click(eyeBtn);
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("does not call onReveal when revealed value already present", () => {
    const onReveal = vi.fn().mockResolvedValue(undefined);
    render(<SecretField value="••••" revealed="already-here" onReveal={onReveal} />);
    const eyeBtn = screen.getByTitle("Mostrar valor");
    fireEvent.click(eyeBtn);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("calls onChange when typing (not readOnly)", () => {
    const onChange = vi.fn();
    render(<SecretField value="" revealed="real" onChange={onChange} />);
    // Reveal first so we can type
    fireEvent.click(screen.getByTitle("Mostrar valor"));
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-value" } });
    expect(onChange).toHaveBeenCalledWith("new-value");
  });

  it("does not call onChange when readOnly", () => {
    const onChange = vi.fn();
    render(<SecretField value="••••" readOnly onChange={onChange} />);
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows copy button", () => {
    render(<SecretField value="••••1234" />);
    expect(screen.getByTitle("Copiar al portapapeles")).toBeInTheDocument();
  });

  it("copies masked value when not revealed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SecretField value="••••1234" />);
    fireEvent.click(screen.getByTitle("Copiar al portapapeles"));
    expect(writeText).toHaveBeenCalledWith("••••1234");
  });

  it("input is disabled when disabled prop is true", () => {
    render(<SecretField value="••••" disabled />);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
