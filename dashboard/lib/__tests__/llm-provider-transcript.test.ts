import { describe, it, expect } from "vitest";
import { serializeChatMessagesForCli } from "@/lib/llm-provider/cli/transcript";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

describe("serializeChatMessagesForCli", () => {
  it("serializes system, user, assistant, and tool roles", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "list_ps_tables", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
    ];
    const s = serializeChatMessagesForCli(messages);
    expect(s).toContain("### system");
    expect(s).toContain("sys");
    expect(s).toContain("### user");
    expect(s).toContain("hi");
    expect(s).toContain("### assistant");
    expect(s).toContain("list_ps_tables");
    expect(s).toContain("### tool_result id=c1");
    expect(s).toContain('{"ok":true}');
  });
});
