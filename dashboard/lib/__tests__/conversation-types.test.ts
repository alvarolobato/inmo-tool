import { describe, it, expect } from "vitest";
import {
  getMessageText,
  isAssistantContent,
  isToolResultContent,
  type MessageContent,
} from "@/lib/conversation-types";

describe("getMessageText", () => {
  it("returns plain string for legacy string content", () => {
    const content: MessageContent = "legacy message";
    expect(getMessageText(content)).toBe("legacy message");
  });

  it("returns text from AssistantMessageContent with text field", () => {
    const content: MessageContent = { text: "hello world" };
    expect(getMessageText(content)).toBe("hello world");
  });

  it("returns empty string for AssistantMessageContent with no text field", () => {
    const content: MessageContent = { tool_calls: [] };
    expect(getMessageText(content)).toBe("");
  });

  it("returns empty string when text is undefined", () => {
    const content: MessageContent = { is_error: true };
    expect(getMessageText(content)).toBe("");
  });

  it("returns empty string for tool result content", () => {
    const content: MessageContent = {
      tool_call_id: "call_1",
      tool_name: "execute_query",
      content: { rows: [] },
    };
    expect(getMessageText(content)).toBe("");
  });
});

describe("isAssistantContent", () => {
  it("returns true for object with text field", () => {
    expect(isAssistantContent({ text: "hi" })).toBe(true);
  });

  it("returns true for object with tool_calls field", () => {
    expect(isAssistantContent({ tool_calls: [] })).toBe(true);
  });

  it("returns true for object with is_error field", () => {
    expect(isAssistantContent({ is_error: true })).toBe(true);
  });

  it("returns false for tool result content (has tool_call_id)", () => {
    expect(isAssistantContent({ tool_call_id: "x", tool_name: "y", content: null })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAssistantContent(null as unknown as MessageContent)).toBe(false);
  });
});

describe("isToolResultContent", () => {
  it("returns true for object with tool_call_id", () => {
    expect(isToolResultContent({ tool_call_id: "x", tool_name: "y", content: null })).toBe(true);
  });

  it("returns false for assistant content", () => {
    expect(isToolResultContent({ text: "hi" })).toBe(false);
  });
});
