import { describe, expect, it } from "vite-plus/test";
import { classifyDroidRuntimeTestRequest } from "./DroidRuntimeTestRequests.ts";

const title = "You are a helper that generates concise session titles for a session picker.";

describe("Droid runtime fixture request ownership", () => {
  it("recognizes tool-free title requests across the three model protocols", () => {
    for (const request of [
      { messages: [{ role: "system", content: title }] },
      { instructions: title, input: [{ role: "user", content: "Task" }], tools: [] },
      { system: [{ type: "text", text: title }] },
      { system: title },
      { input: [{ role: "system", content: [{ type: "input_text", text: title }] }] },
      // Droid on macOS sent this shape over the Responses protocol: the title prompt follows
      // Droid's own system prompt in a developer message, and the request asks for reasoning.
      {
        include: ["reasoning.encrypted_content"],
        input: [
          {
            role: "developer",
            content: [
              {
                type: "input_text",
                text: `You are Droid, an AI software engineering agent built by Factory.\n\n${title}`,
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "<first_message>\nTask\n</first_message>" }],
          },
        ],
        tools: [],
      },
    ]) {
      expect(classifyDroidRuntimeTestRequest(request)).toBe("title");
    }
  });

  it("does not hide missing tools or user text that resembles a title prompt", () => {
    for (const request of [
      {},
      { tools: [] },
      { tools: "malformed" },
      { messages: [{ role: "user", content: title }] },
      { messages: [{ role: "system", content: "Unrecognized auxiliary work" }] },
      { input: [{ role: "developer", content: [{ type: "input_text", text: "Other work" }] }] },
      { input: [{ role: "assistant", content: [{ type: "output_text", text: title }] }] },
    ]) {
      expect(classifyDroidRuntimeTestRequest(request)).toBe("unexpected");
    }
  });

  it("keeps tool-bearing agent requests even when conversation text mentions titles", () => {
    expect(
      classifyDroidRuntimeTestRequest({
        tools: [{ type: "function", function: { name: "Read" } }],
        messages: [{ role: "system", content: title }],
      }),
    ).toBe("agent");
  });
});
