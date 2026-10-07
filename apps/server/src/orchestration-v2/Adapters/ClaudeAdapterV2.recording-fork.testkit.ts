import { forkSession, type SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderReplayEntry, type ModelSelection } from "@t3tools/contracts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  RecordingPromptQueue,
  openRecordingQuery,
  recordMessagesUntilTurnResultWithCursor,
  requireAssistantCursor,
  sanitizedReplayCwd,
  recordMessagesUntilTurnResult,
  serializeReplayError,
} from "./ClaudeAdapterV2.recording-io.testkit.ts";
import {
  makeClaudeQueryOpenFrame,
  makeClaudePromptOfferFrame,
} from "./ClaudeAdapterV2.replay-query.testkit.ts";

async function recordClaudeForkSessionQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly forkFromPromptIndex?: 1 | 2;
  readonly sourcePromptCount?: number;
  readonly forkPromptGroups?: ReadonlyArray<ReadonlyArray<string>>;
  readonly sourceContinuationPromptCount?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least two prompts.`,
    );
  }
  const sourceContinuationPromptCount = input.sourceContinuationPromptCount ?? 0;
  const forkPromptEnd = input.prompts.length - sourceContinuationPromptCount;
  const sourcePromptCount = input.sourcePromptCount ?? forkPromptEnd - 1;
  if (
    sourceContinuationPromptCount < 0 ||
    sourceContinuationPromptCount >= input.prompts.length ||
    sourcePromptCount < 1 ||
    sourcePromptCount >= forkPromptEnd
  ) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least one source prompt and one fork prompt.`,
    );
  }
  const forkFromPromptIndex = input.forkFromPromptIndex ?? sourcePromptCount;
  if (forkFromPromptIndex > sourcePromptCount) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} cannot fork from prompt ${forkFromPromptIndex} after recording ${sourcePromptCount} source prompts.`,
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
    for (const [index, prompt] of input.prompts.slice(0, sourcePromptCount).entries()) {
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

    const upToMessageId = sourceCursors[forkFromPromptIndex - 1]!;
    const forkPrompts = input.prompts.slice(sourcePromptCount, forkPromptEnd);
    const forkPromptGroups = input.forkPromptGroups ?? [forkPrompts];
    if (
      forkPromptGroups.length === 0 ||
      forkPromptGroups.some((group) => group.length === 0) ||
      forkPromptGroups.flat().join("\n") !== forkPrompts.join("\n")
    ) {
      throw new Error(
        `Claude fork-session replay scenario ${input.scenario} has invalid fork prompt groups.`,
      );
    }
    input.metadata.sourceAssistantMessageUuids = sourceCursors;
    input.metadata.forkUpToMessageId = upToMessageId;
    const forkedNativeSessionIds: Array<string> = [];
    let promptOrdinal = sourcePromptCount;
    for (const [groupIndex, forkPrompts] of forkPromptGroups.entries()) {
      const labelSuffix = forkPromptGroups.length === 1 ? "" : `:${groupIndex + 1}`;
      input.entries.push({
        type: "expect_outbound",
        label: `session.fork${labelSuffix}`,
        frame: {
          type: "session.fork",
          sessionId: input.sessionId,
          options: {
            dir: sanitizedReplayCwd(input.scenario),
            upToMessageId,
          },
        },
      });
      const forked = await forkSession(input.sessionId, {
        dir: input.cwd,
        upToMessageId,
      });
      forkedNativeSessionIds.push(forked.sessionId);
      input.entries.push({
        type: "emit_inbound",
        label: `session.forked${labelSuffix}`,
        frame: {
          type: "session.forked",
          sessionId: forked.sessionId,
        },
      });

      const targetPromptQueue = new RecordingPromptQueue();
      const targetOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: input.modelSelection,
        nativeThreadId: forked.sessionId,
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
        label: `query.open:fork${labelSuffix}`,
        frame: makeClaudeQueryOpenFrame({ options: targetOptions }),
      });
      const targetRuntime = await openRecordingQuery({
        prompt: targetPromptQueue,
        options: targetOptions,
      });
      const targetIterator = targetRuntime[Symbol.asyncIterator]();
      for (const prompt of forkPrompts) {
        promptOrdinal += 1;
        const targetMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(targetMessage),
        });
        targetPromptQueue.offer(targetMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: targetIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(`Claude fork query ended before prompt ${promptOrdinal} completed.`);
        }
      }
      targetPromptQueue.close();
      targetRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    }
    input.metadata.forkedNativeSessionId = forkedNativeSessionIds[0];
    input.metadata.forkedNativeSessionIds = forkedNativeSessionIds;
    if (sourceContinuationPromptCount > 0) {
      const continuationPromptQueue = new RecordingPromptQueue();
      const continuationOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
        label: "query.open:source-continuation",
        frame: makeClaudeQueryOpenFrame({ options: continuationOptions }),
      });
      const continuationRuntime = await openRecordingQuery({
        prompt: continuationPromptQueue,
        options: continuationOptions,
      });
      const continuationIterator = continuationRuntime[Symbol.asyncIterator]();
      for (const prompt of input.prompts.slice(forkPromptEnd)) {
        promptOrdinal += 1;
        const continuationMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(continuationMessage),
        });
        continuationPromptQueue.offer(continuationMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: continuationIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(
            `Claude source continuation ended before prompt ${promptOrdinal} completed.`,
          );
        }
      }
      continuationPromptQueue.close();
      continuationRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
      input.metadata.sourceContinuationPromptCount = sourceContinuationPromptCount;
    }
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
export { recordClaudeForkSessionQuery };
