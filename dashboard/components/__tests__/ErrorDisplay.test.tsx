// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ErrorDisplay } from "../ErrorDisplay";
import type { ApiErrorResponse } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const structuredError: ApiErrorResponse = {
  error: "No se pudo cargar el dashboard",
  code: "DB_CONNECTION",
  details: "Connection refused at 127.0.0.1:5432",
  timestamp: "2026-04-05T10:00:00.000Z",
  requestId: "req_abc123",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ErrorDisplay", () => {
  it("renders a plain string error", () => {
    render(<ErrorDisplay error="Algo salió mal" />);
    expect(screen.getByText("Algo salió mal")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders user-facing message from structured error", () => {
    render(<ErrorDisplay error={structuredError} />);
    expect(
      screen.getByText("No se pudo cargar el dashboard"),
    ).toBeInTheDocument();
  });

  it("shows optional title when provided", () => {
    render(<ErrorDisplay error="Error" title="Widget roto" />);
    expect(screen.getByText("Widget roto")).toBeInTheDocument();
  });

  it("does not show title when not provided", () => {
    render(<ErrorDisplay error="Error" />);
    expect(screen.queryByText("Widget roto")).not.toBeInTheDocument();
  });

  it("shows 'Detalles técnicos' toggle for structured errors", () => {
    render(<ErrorDisplay error={structuredError} />);
    expect(screen.getByTestId("toggle-details")).toBeInTheDocument();
  });

  it("does not show details toggle for plain string errors", () => {
    render(<ErrorDisplay error="Plain error" />);
    expect(screen.queryByTestId("toggle-details")).not.toBeInTheDocument();
  });

  it("expands and collapses technical details on toggle click", () => {
    render(<ErrorDisplay error={structuredError} />);

    // Initially collapsed
    expect(screen.queryByTestId("technical-details")).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByTestId("toggle-details"));
    expect(screen.getByTestId("technical-details")).toBeInTheDocument();
    expect(screen.getByText("DB_CONNECTION")).toBeInTheDocument();
    expect(screen.getByText("req_abc123")).toBeInTheDocument();
    expect(
      screen.getByText("Connection refused at 127.0.0.1:5432"),
    ).toBeInTheDocument();

    // Collapse again
    fireEvent.click(screen.getByTestId("toggle-details"));
    expect(screen.queryByTestId("technical-details")).not.toBeInTheDocument();
  });

  it("shows 'Copiar detalles' button for structured errors", () => {
    render(<ErrorDisplay error={structuredError} />);
    expect(screen.getByTestId("copy-details")).toBeInTheDocument();
  });

  it("renders 'Reintentar' button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(<ErrorDisplay error="Error" onRetry={onRetry} />);
    expect(screen.getByTestId("retry-button")).toBeInTheDocument();
  });

  it("calls onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorDisplay error="Error" onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId("retry-button"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not render retry button when onRetry is not provided", () => {
    render(<ErrorDisplay error={structuredError} />);
    expect(screen.queryByTestId("retry-button")).not.toBeInTheDocument();
  });

  it("copies full error details to clipboard on button click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );

    try {
      Object.assign(navigator, { clipboard: { writeText } });

      render(<ErrorDisplay error={structuredError} />);
      fireEvent.click(screen.getByTestId("copy-details"));

      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify(structuredError, null, 2),
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalDescriptor);
      } else {
        delete (navigator as unknown as Record<string, unknown>).clipboard;
      }
    }
  });
});
