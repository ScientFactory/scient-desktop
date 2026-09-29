import { describe, expect, it, vi } from "vite-plus/test";
import { piContextExtension } from "./PiContextExtension.ts";
import { piContextErrorMessage } from "./PiContextError.ts";

type Api = Parameters<typeof piContextExtension>[0];
type Handler = Parameters<Api["on"]>[1];
type Context = Parameters<Handler>[1];
function harness(contextWindow = 100_000) {
  let beforeRequest: Handler | undefined;
  let input: (() => void) | undefined;
  let compactCommand: Parameters<Api["registerCommand"]>[1] | undefined;
  const compact = vi.fn<Context["compact"]>();
  const abort = vi.fn();
  const notify = vi.fn();
  const sendMessage = vi.fn();
  piContextExtension({
    on: ((name: string, handler: Handler) => {
      if (name === "before_provider_request") beforeRequest = handler;
      if (name === "input") input = handler as unknown as () => void;
    }) as Api["on"],
    registerCommand: (_name, command) => {
      compactCommand = command;
    },
    sendMessage,
  });
  const ctx: Context = {
    model: { contextWindow, maxTokens: 65_536 },
    getContextUsage: () => undefined,
    compact,
    abort,
    ui: { notify },
  };
  return {
    ctx,
    compact,
    abort,
    notify,
    sendMessage,
    run: (payload: unknown) => beforeRequest!({ payload }, ctx),
    command: (args = "") => compactCommand!.handler(args, ctx),
    nextInput: () => input!(),
  };
}

describe("Pi final request budget", () => {
  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens"])(
    "caps %s including final instructions and tools without changing the input",
    (field) => {
      const h = harness();
      const payload = {
        messages: [{ role: "user", content: "work" }],
        tools: [{ description: "t".repeat(90_000) }],
        instructions: "s".repeat(90_000),
        [field]: 65_536,
      };
      const before = JSON.stringify(payload);
      const result = h.run(payload) as Record<string, unknown>;
      expect(result[field]).toBeLessThan(35_000);
      expect(result.messages).toEqual(payload.messages);
      expect(result.tools).toEqual(payload.tools);
      expect(JSON.stringify(payload)).toBe(before);
      expect(h.compact).not.toHaveBeenCalled();
    },
  );

  it("accounts for image input and preserves Anthropic thinking constraints", () => {
    const h = harness();
    const result = h.run({
      messages: [
        { content: [{ type: "image", source: { type: "base64", data: "a".repeat(1_000_000) } }] },
      ],
      max_tokens: 90_000,
      thinking: { type: "enabled", budget_tokens: 80_000 },
    }) as { max_tokens: number; thinking: { budget_tokens: number } };
    expect(result.max_tokens).toBeGreaterThan(70_000);
    expect(result.max_tokens).toBeLessThan(79_000);
    expect(result.thinking.budget_tokens).toBeLessThanOrEqual(result.max_tokens - 1_024);
  });

  it("uses native occupancy when it exceeds the text estimate", () => {
    const h = harness();
    Object.assign(h.ctx, { getContextUsage: () => ({ tokens: 80_000 }) });
    expect(h.run({ messages: [], max_tokens: 50_000 })).toMatchObject({ max_tokens: 15_000 });
  });

  it("bounds Gemini output and thinking while accounting for its response schema", () => {
    const h = harness();
    const payload = {
      contents: [{ parts: [{ text: "continue" }] }],
      generationConfig: {
        maxOutputTokens: 65_536,
        responseSchema: { description: "s".repeat(210_000) },
        thinkingConfig: { thinkingBudget: 40_000 },
      },
    };
    const result = h.run(payload) as typeof payload;
    expect(result.generationConfig.maxOutputTokens).toBeLessThan(25_000);
    expect(result.generationConfig.thinkingConfig.thinkingBudget).toBeLessThanOrEqual(
      result.generationConfig.maxOutputTokens - 1_024,
    );
    expect(result.generationConfig.responseSchema).toEqual(payload.generationConfig.responseSchema);
    expect(payload.generationConfig.maxOutputTokens).toBe(65_536);
  });

  it("compacts once before an oversized request, then continues without replaying the user prompt", () => {
    const h = harness();
    const payload = { messages: [{ content: "x".repeat(300_000) }], max_tokens: 50_000 };
    h.run(payload);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("scient:context-recovery:"),
      "info",
    );
    expect(h.compact).toHaveBeenCalledTimes(1);
    h.compact.mock.calls[0]![0].onComplete();
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "scient-context-continuation", display: false }),
      { triggerTurn: true },
    );
    h.run(payload);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.abort).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("scient:context-limit:"),
      "error",
    );
    h.nextInput();
    h.run(payload);
    expect(h.compact).toHaveBeenCalledTimes(2);
  });

  it("keeps Gemini thinking inside an already smaller answer allowance", () => {
    const h = harness();
    const result = h.run({
      contents: [{ parts: [{ text: "continue" }] }],
      generationConfig: {
        maxOutputTokens: 4_096,
        thinkingConfig: { thinkingBudget: 8_192 },
      },
    });
    expect(result).toMatchObject({
      generationConfig: {
        maxOutputTokens: 4_096,
        thinkingConfig: { thinkingBudget: 3_072 },
      },
    });
  });

  it("reports failed compaction without continuing or dropping input", () => {
    const h = harness();
    h.run({ messages: [{ content: "x".repeat(300_000) }] });
    h.compact.mock.calls[0]![0].onError(new Error("synthetic failure"));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("scient:context-limit:"),
      "error",
    );
  });

  it("does not invent a model context window", () => {
    const h = harness(0);
    expect(h.run({ messages: [], max_tokens: 5_000 })).toBeUndefined();
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("waits for native manual compaction and propagates failure", async () => {
    const h = harness();
    let completed = false;
    const pending = h.command("preserve decisions").then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(h.compact.mock.calls[0]![0].customInstructions).toBe("preserve decisions");
    h.compact.mock.calls[0]![0].onComplete();
    await pending;
    const failed = h.command();
    h.compact.mock.calls[1]![0].onError(new Error("compaction failed"));
    await expect(failed).rejects.toThrow("compaction failed");
  });
});

it("gives context failures an actionable explanation without misclassifying rate limits", () => {
  expect(
    piContextErrorMessage(
      "400 This endpoint's maximum context length is 1000000 tokens. However, you requested about 1001776 tokens",
    ),
  ).toContain("Compact this conversation");
  expect(piContextErrorMessage("429 rate limit: too many tokens")).toBe(
    "429 rate limit: too many tokens",
  );
  expect(piContextErrorMessage("Invalid API key")).toBe("Invalid API key");
});
