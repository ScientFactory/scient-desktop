/** Runs inside the native Pi runtime; keep this function self-contained. */
export function piContextExtension(pi: {
  on(event: "input", handler: () => void): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { triggerTurn: boolean },
  ): void;
  on(
    event: "before_provider_request",
    handler: (event: { payload: unknown }, ctx: PiContext) => unknown,
  ): void;
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: PiContext) => Promise<void> },
  ): void;
}) {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

  let recoveryAttempted = false;
  pi.on("input", () => {
    recoveryAttempted = false;
  });

  // The endpoint remains authoritative. Account for the final serialized system,
  // tools and messages, with a conservative image allowance rather than treating
  // base64 bytes as text tokens. No message or tool result is removed.
  const inputEstimate = (payload: Record<string, unknown>) => {
    let images = 0;
    const input = { ...payload };
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
      delete input[key];
    const serialized = JSON.stringify(input, (_key, value: unknown) => {
      const part = record(value);
      if (
        part &&
        (part.type === "image" ||
          part.type === "image_url" ||
          part.type === "input_image" ||
          record(part.inlineData)?.mimeType?.toString().startsWith("image/"))
      ) {
        images += 1;
        return { type: "image" };
      }
      return value;
    });
    return Math.ceil(new TextEncoder().encode(serialized).byteLength / 3) + images * 16_384;
  };

  pi.on("before_provider_request", ({ payload }, ctx) => {
    const body = record(payload);
    const window = ctx.model?.contextWindow;
    if (!body || !positive(window)) return;
    const nativeTokens = ctx.getContextUsage()?.tokens;
    const inputTokens = Math.max(inputEstimate(body), positive(nativeTokens) ? nativeTokens : 0);
    const headroom = Math.min(32_768, Math.max(1_024, Math.ceil(window * 0.05)));
    const available = Math.floor(window - inputTokens - headroom);
    const thinking = record(body.thinking);
    const minimumOutput =
      thinking?.type === "enabled"
        ? 2_048
        : Math.min(1_024, positive(ctx.model?.maxTokens) ? ctx.model.maxTokens : 1_024);
    if (available < minimumOutput) {
      if (recoveryAttempted) {
        ctx.ui.notify(
          "scient:context-limit: Context still exceeds the safe budget after compaction.",
          "error",
        );
        ctx.abort();
        return;
      }
      recoveryAttempted = true;
      ctx.ui.notify("scient:context-recovery: Compacting before the next request.", "info");
      // Native compact aborts the unsent request first. Never await it from a
      // request hook: it waits for this agent cycle to stop.
      ctx.compact({
        onComplete: () =>
          pi.sendMessage(
            {
              customType: "scient-context-continuation",
              content:
                "Context was compacted before the next request. Continue the user's current task from the saved progress. Do not repeat completed tool actions.",
              display: false,
            },
            { triggerTurn: true },
          ),
        onError: () =>
          ctx.ui.notify(
            "scient:context-limit: Automatic compaction could not make room for the next request.",
            "error",
          ),
      });
      return;
    }
    const result = { ...body };
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      if (positive(result[key])) result[key] = Math.min(result[key], available);
    }
    const config = record(body.generationConfig);
    if (config && positive(config.maxOutputTokens)) {
      const thinkingConfig = record(config.thinkingConfig);
      result.generationConfig = {
        ...config,
        maxOutputTokens: Math.min(config.maxOutputTokens, available),
        ...(thinkingConfig && positive(thinkingConfig.thinkingBudget)
          ? {
              thinkingConfig: {
                ...thinkingConfig,
                thinkingBudget: Math.min(thinkingConfig.thinkingBudget, available - 1_024),
              },
            }
          : {}),
      };
    }
    if (thinking?.type === "enabled" && positive(thinking.budget_tokens)) {
      const output = positive(result.max_tokens) ? result.max_tokens : available;
      result.thinking = {
        ...thinking,
        budget_tokens: Math.min(thinking.budget_tokens, output - 1_024),
      };
    }
    return result;
  });

  // RPC prompt mode does not implement the TUI's built-in /compact command.
  // A registered command gives Scient's existing Compact action the real native
  // operation, including its completion and error callbacks.
  pi.registerCommand("compact", {
    description: "Compact conversation context while preserving the saved transcript",
    handler: async (args, ctx) => {
      await new Promise<void>((resolve, reject) =>
        ctx.compact({
          ...(args.trim() ? { customInstructions: args.trim() } : {}),
          onComplete: () => resolve(),
          onError: reject,
        }),
      );
    },
  });
}

interface PiContext {
  readonly model?: { readonly contextWindow?: number; readonly maxTokens?: number };
  readonly getContextUsage: () => { readonly tokens: number | null } | undefined;
  readonly abort: () => void;
  readonly ui: { readonly notify: (message: string, kind: string) => void };
  readonly compact: (options: {
    readonly customInstructions?: string;
    readonly onComplete: () => void;
    readonly onError: (error: Error) => void;
  }) => void;
}
