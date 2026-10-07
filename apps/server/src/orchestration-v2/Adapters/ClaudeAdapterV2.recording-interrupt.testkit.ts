import { ProviderReplayEntry, type ModelSelection } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  RecordingPromptQueue,
  openRecordingQuery,
  recordMessagesUntilToolUse,
  recordMessagesUntilIteratorDone,
  serializeReplayError,
} from "./ClaudeAdapterV2.recording-io.testkit.ts";
import {
  makeClaudeQueryOpenFrame,
  makeClaudePromptOfferFrame,
} from "./ClaudeAdapterV2.replay-query.testkit.ts";

async function recordInterruptedClaudeQuery(input: {
  readonly scenario: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly entries: Array<ProviderReplayEntry>;
  readonly queryOpenLabel: string;
  readonly promptOfferLabel: string;
  readonly interruptLabel: string;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  // With interruptAfter "tool_use": interrupt after this many root tool uses.
  readonly interruptAfterToolUses?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: input.resume,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: input.queryOpenLabel,
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const runtime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = runtime[Symbol.asyncIterator]();
  const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompt });
  input.entries.push({
    type: "expect_outbound",
    label: input.promptOfferLabel,
    frame: makeClaudePromptOfferFrame(message),
  });
  promptQueue.offer(message);

  try {
    if (input.interruptAfter === "tool_use") {
      await recordMessagesUntilToolUse({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
        toolUseCount: input.interruptAfterToolUses ?? 1,
      });
      await Effect.runPromise(Effect.sleep(Duration.millis(250)));
    }
    input.entries.push({
      type: "expect_outbound",
      label: input.interruptLabel,
      frame: { type: "query.interrupt" },
    });

    let cancelledError: unknown;
    try {
      await runtime.interrupt();
    } catch (error) {
      cancelledError = error;
    }
    promptQueue.close();
    runtime.close();
    try {
      await recordMessagesUntilIteratorDone({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
      });
    } catch (error) {
      cancelledError = error;
    }
    input.entries.push({
      type: "runtime_exit",
      status: cancelledError === undefined ? "success" : "cancelled",
      ...(cancelledError === undefined
        ? {}
        : { error: serializeReplayError(cancelledError, input.scenario) }),
    });
  } catch (error) {
    promptQueue.close();
    runtime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeInterruptQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
}): Promise<void> {
  if (input.prompts.length !== 1) {
    throw new Error(
      `Claude interrupt replay scenario ${input.scenario} requires exactly one prompt.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.interruptAfterToolUses === undefined
      ? {}
      : { interruptAfterToolUses: input.interruptAfterToolUses }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });
}

async function recordClaudeInterruptRestartQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
}): Promise<void> {
  if (input.prompts.length !== 2) {
    throw new Error(
      `Claude interrupt-restart replay scenario ${input.scenario} requires exactly two prompts.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open:1",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });

  const secondPromptQueue = new RecordingPromptQueue();
  const secondOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: true,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open:2",
    frame: makeClaudeQueryOpenFrame({ options: secondOptions }),
  });
  const secondMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[1]! });
  input.entries.push({
    type: "expect_outbound",
    label: "prompt.offer:2",
    frame: makeClaudePromptOfferFrame(secondMessage),
  });

  try {
    const secondRuntime = await openRecordingQuery({
      prompt: secondPromptQueue,
      options: secondOptions,
    });
    secondPromptQueue.offer(secondMessage);
    secondPromptQueue.close();
    const secondIterator = secondRuntime[Symbol.asyncIterator]();
    await recordMessagesUntilIteratorDone({
      iterator: secondIterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    secondRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    secondPromptQueue.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}
export { recordClaudeInterruptQuery, recordClaudeInterruptRestartQuery };
