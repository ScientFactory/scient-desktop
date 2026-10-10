import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import {
  type CanUseTool,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  RecordingPromptQueue,
  permissionRequestFrame,
  permissionResultForRecording,
  openRecordingQuery,
  RecordingMessageReader,
  recordMessagesUntilTurnResult,
  isTaskNotificationOriginResultFrame,
  isSystemInitFrame,
  CLAUDE_RECORDING_WAKE_QUIET_MS,
  serializeReplayError,
  recordMessagesUntilTurnResults,
  sanitizeSdkMessageForReplay,
  recordMessagesUntilTurnResultWithCursor,
  requireAssistantCursor,
  recordMessagesUntilTurnResultAndFinalize,
} from "./ClaudeAdapterV2.recording-io.testkit.ts";
import {
  makeClaudePermissionResponseFrame,
  claudeBackgroundWakeResultLabel,
} from "./ClaudeAdapterV2.replay-protocol.testkit.ts";
import {
  makeClaudeQueryOpenFrame,
  makeClaudePromptOfferFrame,
} from "./ClaudeAdapterV2.replay-query.testkit.ts";

async function recordClaudeStreamingQuery(input: {
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
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  // Per prompt, how many turns Claude starts on its own for background work
  // (task-notification-origin results) to wait for before the next prompt.
  // Setting it also records any further wake turn that starts within a short
  // quiet window, so the next prompt is not offered while one is queued.
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  // Skip that quiet window: offer the next prompt while a wake may still be
  // queued in the CLI, which then runs the wake turn first.
  readonly offerNextPromptImmediately?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
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
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = new RecordingMessageReader(queryRuntime[Symbol.asyncIterator]());
  let wakeNumber = 0;
  // Records one turn and labels it when Claude started it for background work.
  const recordTurn = async (promptNumber: number): Promise<"prompt" | "wake"> => {
    const completed = await recordMessagesUntilTurnResult({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    if (!completed) {
      throw new Error(
        `Claude streaming query ended before prompt ${promptNumber} and its background wakes completed.`,
      );
    }
    const resultEntry = input.entries.at(-1);
    const resultFrame = resultEntry?.type === "emit_inbound" ? resultEntry.frame : undefined;
    if (!isTaskNotificationOriginResultFrame(resultFrame)) {
      return "prompt";
    }
    wakeNumber += 1;
    // A distinct label lets a replay gate hold the wake result until the
    // continuation run that ingests it has started.
    input.entries[input.entries.length - 1] = {
      type: "emit_inbound",
      label: claudeBackgroundWakeResultLabel(wakeNumber),
      frame: resultFrame,
    };
    return "wake";
  };
  try {
    for (const [index, prompt] of input.prompts.entries()) {
      // Like the adapter, give each prompt a uuid Claude echoes on its turn.
      const promptUuid = await Effect.runPromise(
        Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4).pipe(
          Effect.provide(NodeCrypto.layer),
        ),
      );
      if (!ClaudeAdapterV2.isClaudePromptUuid(promptUuid))
        throw new Error("Failed to allocate a Claude recording prompt uuid.");
      const message = ClaudeAdapterV2.makeClaudeUserMessage({
        text: prompt,
        uuid: promptUuid,
      });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      promptQueue.offer(message);
      // A task notification that lands during a turn queues a wake turn the
      // CLI can run before this prompt's turn, so results are told apart by
      // origin rather than by arrival order.
      let promptSettled = false;
      let wakes = 0;
      const expectedWakes = input.backgroundWakeCounts?.[index] ?? 0;
      while (!promptSettled || wakes < expectedWakes) {
        if ((await recordTurn(index + 1)) === "prompt") {
          promptSettled = true;
        } else {
          wakes += 1;
        }
      }
      if (input.backgroundWakeCounts !== undefined && input.offerNextPromptImmediately !== true) {
        // Every turn opens with system:init; frames from still-running
        // subagents are left for the next prompt's recording.
        while (isSystemInitFrame(await iterator.peekWithin(CLAUDE_RECORDING_WAKE_QUIET_MS))) {
          await recordTurn(index + 1);
        }
      }
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeActiveSteeringQuery(input: {
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
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error("Claude active steering replay recording requires at least two prompts.");
  }

  const promptQueue = new RecordingPromptQueue();
  const offeredPrompts = new Set<number>();
  const offerPrompt = (index: number, priority?: SDKUserMessage["priority"]) => {
    const message = ClaudeAdapterV2.makeClaudeUserMessage({
      text: input.prompts[index]!,
      ...(priority === undefined ? {} : { priority }),
    });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });
    promptQueue.offer(message);
    offeredPrompts.add(index);
  };
  const offerSteeringPrompts = () => {
    for (let index = 1; index < input.prompts.length; index += 1) {
      if (!offeredPrompts.has(index)) {
        offerPrompt(index, "now");
      }
    }
  };

  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
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
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = queryRuntime[Symbol.asyncIterator]();
  try {
    offerPrompt(0);
    offerSteeringPrompts();
    const completed = await recordMessagesUntilTurnResults({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
      resultCount: input.prompts.length,
    });
    if (!completed) {
      throw new Error("Claude active steering query ended before the turn completed.");
    }
    if (offeredPrompts.size < input.prompts.length) {
      throw new Error("Claude active steering prompts were not all offered before completion.");
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

async function recordClaudeRestartingQueries(input: {
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
}): Promise<void> {
  for (const [index, prompt] of input.prompts.entries()) {
    const promptQueue = new RecordingPromptQueue();
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      nativeThreadId: input.sessionId,
      resume: index > 0,
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
      label: `query.open:${index + 1}`,
      frame: makeClaudeQueryOpenFrame({ options }),
    });
    const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });

    try {
      const queryRuntime = await openRecordingQuery({
        prompt: promptQueue,
        options,
      });
      promptQueue.offer(message);
      promptQueue.close();
      const iterator = queryRuntime[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const replayMessage = sanitizeSdkMessageForReplay({
          message: next.value,
          scenario: input.scenario,
        });
        input.entries.push({
          type: "emit_inbound",
          label: replayMessage.type,
          frame: replayMessage,
        });
      }
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    } catch (error) {
      promptQueue.close();
      input.entries.push({
        type: "runtime_exit",
        status: "error",
        error: serializeReplayError(error, input.scenario),
      });
      throw error;
    }
  }
}

async function recordClaudeResumeAtCursorQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length !== 3) {
    throw new Error(
      `Claude resume-at-cursor replay scenario ${input.scenario} requires exactly three prompts.`,
    );
  }

  const sourcePromptQueue = new RecordingPromptQueue();
  const sourceOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
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
    label: "query.open:source",
    frame: makeClaudeQueryOpenFrame({ options: sourceOptions }),
  });
  const sourceRuntime = await openRecordingQuery({
    prompt: sourcePromptQueue,
    options: sourceOptions,
  });
  const sourceIterator = sourceRuntime[Symbol.asyncIterator]();

  try {
    const sourceCursors: Array<SDKAssistantMessage["uuid"]> = [];
    for (const [index, prompt] of input.prompts.slice(0, 2).entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      sourcePromptQueue.offer(message);
      const result = await recordMessagesUntilTurnResultWithCursor({
        iterator: sourceIterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!result.completed) {
        throw new Error(`Claude source query ended before prompt ${index + 1} completed.`);
      }
      sourceCursors.push(
        requireAssistantCursor({
          scenario: input.scenario,
          promptIndex: index + 1,
          cursor: result.assistantMessageUuid,
        }),
      );
    }
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });

    const resumeSessionAt = sourceCursors[0]!;
    input.metadata.resumeSessionAt = resumeSessionAt;
    input.metadata.sourceAssistantMessageUuids = sourceCursors;

    const resumedPromptQueue = new RecordingPromptQueue();
    const resumedOptions = {
      ...ClaudeAdapterV2.makeClaudeQueryOptions({
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
      }),
      resumeSessionAt,
    } satisfies ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
    input.entries.push({
      type: "expect_outbound",
      label: "query.open:resume_at_cursor",
      frame: makeClaudeQueryOpenFrame({ options: resumedOptions }),
    });
    const resumedMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[2]! });
    input.entries.push({
      type: "expect_outbound",
      label: "prompt.offer:3",
      frame: makeClaudePromptOfferFrame(resumedMessage),
    });

    const resumedRuntime = await openRecordingQuery({
      prompt: resumedPromptQueue,
      options: resumedOptions,
    });
    resumedPromptQueue.offer(resumedMessage);
    resumedPromptQueue.close();
    const resumedIterator = resumedRuntime[Symbol.asyncIterator]();
    const resumed = await recordMessagesUntilTurnResultAndFinalize({
      iterator: resumedIterator,
      entries: input.entries,
      scenario: input.scenario,
      finalize: () => {
        resumedPromptQueue.close();
        resumedRuntime.close();
      },
    });
    if (!resumed) {
      throw new Error("Claude resumed query ended before prompt 3 completed.");
    }
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}
export {
  recordClaudeStreamingQuery,
  recordClaudeActiveSteeringQuery,
  recordClaudeRestartingQueries,
  recordClaudeResumeAtCursorQuery,
};
