import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { ProviderReplayEntry, type ProviderApprovalDecision } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  isWindowsClaudeLauncherShimPath,
  resolveClaudeSdkExecutablePath,
} from "../../provider/Drivers/ClaudeExecutable.ts";
import { type ClaudePermissionRequestFrame } from "./ClaudeAdapterV2.replay-protocol.testkit.ts";

function serializeReplayError(error: unknown, scenario?: string): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message:
          scenario === undefined
            ? error.message
            : sanitizeReplayText({ text: error.message, scenario }),
      }
    : error;
}

function permissionResultForRecording(input: {
  readonly decision: ProviderApprovalDecision;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "acceptForSession" ? "user_permanent" : "user_temporary",
      ...(input.decision === "acceptForSession" && input.suggestions !== undefined
        ? { updatedPermissions: input.suggestions }
        : {}),
    };
  }
  return {
    behavior: "deny",
    message:
      input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution.",
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

function permissionRequestFrame(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly callbackOptions: Parameters<CanUseTool>[2];
}): ClaudePermissionRequestFrame {
  const { callbackOptions } = input;
  return {
    type: "permission.request",
    toolName: input.toolName,
    input: input.toolInput,
    options: {
      ...(callbackOptions.suggestions === undefined
        ? {}
        : { suggestions: callbackOptions.suggestions }),
      ...(callbackOptions.blockedPath === undefined
        ? {}
        : { blockedPath: callbackOptions.blockedPath }),
      ...(callbackOptions.decisionReason === undefined
        ? {}
        : { decisionReason: callbackOptions.decisionReason }),
      ...(callbackOptions.title === undefined ? {} : { title: callbackOptions.title }),
      ...(callbackOptions.displayName === undefined
        ? {}
        : { displayName: callbackOptions.displayName }),
      ...(callbackOptions.description === undefined
        ? {}
        : { description: callbackOptions.description }),
      toolUseID: callbackOptions.toolUseID,
      ...(callbackOptions.agentID === undefined ? {} : { agentID: callbackOptions.agentID }),
    },
  };
}

function sanitizedReplayCwd(scenario: string): string {
  return `/tmp/claude-replay-${scenario}`;
}

function parentDirectory(input: string): string {
  const trimmed = input.replace(/\/+$/u, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return trimmed.slice(0, lastSlash);
}

function sanitizeReplayText(input: { readonly text: string; readonly scenario: string }): string {
  const sanitizedCwd = sanitizedReplayCwd(input.scenario);
  const repoRoot = parentDirectory(parentDirectory(process.cwd()));
  return [repoRoot, process.cwd()]
    .toSorted((left, right) => right.length - left.length)
    .reduce((text, localPath) => text.replaceAll(localPath, sanitizedCwd), input.text);
}

function sanitizeSdkMessageForReplay(input: {
  readonly message: SDKMessage;
  readonly scenario: string;
}): SDKMessage {
  const { message } = input;
  if (message.type === "system" && message.subtype === "init") {
    return {
      type: "system",
      subtype: "init",
      ...(message.agents === undefined ? {} : { agents: [] }),
      apiKeySource: message.apiKeySource,
      ...(message.betas === undefined ? {} : { betas: message.betas }),
      claude_code_version: message.claude_code_version,
      cwd: sanitizedReplayCwd(input.scenario),
      tools: [],
      mcp_servers: [],
      model: message.model,
      permissionMode: message.permissionMode,
      slash_commands: [],
      output_style: message.output_style,
      skills: [],
      plugins: [],
      ...(message.fast_mode_state === undefined
        ? {}
        : { fast_mode_state: message.fast_mode_state }),
      uuid: message.uuid,
      session_id: message.session_id,
    };
  }
  // Like init's slash_commands, the recording account's commands and skills
  // are local configuration, not protocol.
  if (message.type === "system" && message.subtype === "commands_changed") {
    return { ...message, commands: [] };
  }
  if (message.type === "rate_limit_event") {
    return {
      ...message,
      rate_limit_info: {
        status: message.rate_limit_info.status,
      },
    };
  }
  if (message.type === "result" && message.subtype !== "success" && message.errors.length > 0) {
    return {
      ...message,
      errors: message.errors.map((error) =>
        sanitizeReplayText({ text: error, scenario: input.scenario }),
      ),
    };
  }
  return message;
}

// Lets a recording wait a bounded time for the next frame without losing it
// when the wait times out: the pending read is handed to the next reader.
class RecordingMessageReader implements AsyncIterator<SDKMessage> {
  private pending: Promise<IteratorResult<SDKMessage>> | undefined;
  private readonly iterator: AsyncIterator<SDKMessage>;

  constructor(iterator: AsyncIterator<SDKMessage>) {
    this.iterator = iterator;
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const pending = this.pending ?? this.iterator.next();
    this.pending = undefined;
    return pending;
  }

  // The next frame if it arrives within `ms`, left unread for next().
  async peekWithin(ms: number): Promise<SDKMessage | undefined> {
    const pending = this.pending ?? this.iterator.next();
    this.pending = pending;
    return Promise.race([
      // A failed read stays pending for next() to surface.
      pending.then(
        (result) => (result.done === true ? undefined : result.value),
        () => undefined,
      ),
      Effect.runPromise(Effect.sleep(Duration.millis(ms))).then(() => undefined),
    ]);
  }
}

class RecordingPromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: Array<IteratorResult<SDKUserMessage>> = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  offer(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Cannot offer a prompt to a closed Claude recording queue.");
    }
    this.push({ done: false, value: message });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.push({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = await this.take();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  private push(result: IteratorResult<SDKUserMessage>): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.pending.push(result);
      return;
    }
    waiter(result);
  }

  private take(): Promise<IteratorResult<SDKUserMessage>> {
    const next = this.pending.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

async function recordMessagesUntilTurnResult(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<boolean> {
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return false;
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
    if (replayMessage.type === "result") {
      return true;
    }
  }
}

async function recordMessagesUntilTurnResultAndFinalize(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  readonly finalize: () => void;
}): Promise<boolean> {
  try {
    return await recordMessagesUntilTurnResult(input);
  } finally {
    input.finalize();
  }
}

async function recordMessagesUntilTurnResultWithCursor(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<{
  readonly completed: boolean;
  readonly assistantMessageUuid: SDKAssistantMessage["uuid"] | null;
}> {
  let assistantMessageUuid: SDKAssistantMessage["uuid"] | null = null;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return { completed: false, assistantMessageUuid };
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
    if (replayMessage.type === "assistant") {
      assistantMessageUuid = replayMessage.uuid;
    }
    if (replayMessage.type === "result") {
      return { completed: true, assistantMessageUuid };
    }
  }
}

function requireAssistantCursor(input: {
  readonly scenario: string;
  readonly promptIndex: number;
  readonly cursor: SDKAssistantMessage["uuid"] | null;
}): SDKAssistantMessage["uuid"] {
  if (input.cursor !== null) {
    return input.cursor;
  }
  throw new Error(
    `Claude replay scenario ${input.scenario} prompt ${input.promptIndex} completed without an SDKAssistantMessage.uuid cursor.`,
  );
}

async function recordMessagesUntilTurnResults(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  readonly resultCount: number;
}): Promise<boolean> {
  let seenResults = 0;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return false;
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
    if (replayMessage.type === "result") {
      seenResults += 1;
      if (seenResults >= input.resultCount) {
        return true;
      }
    }
  }
}

async function recordMessagesUntilIteratorDone(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
}): Promise<void> {
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      return;
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
}

// A queued wake turn starts right after the turn before it settles.
const CLAUDE_RECORDING_WAKE_QUIET_MS = 5_000;

function isSystemInitFrame(message: SDKMessage | undefined): boolean {
  return message?.type === "system" && message.subtype === "init";
}

function isTaskNotificationOriginResultFrame(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null || Reflect.get(frame, "type") !== "result") {
    return false;
  }
  const origin: unknown = Reflect.get(frame, "origin");
  return (
    typeof origin === "object" &&
    origin !== null &&
    Reflect.get(origin, "kind") === "task-notification"
  );
}

function sdkMessageHasRootToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.parent_tool_use_id === null &&
    message.message.content.some((part) => part.type === "tool_use")
  );
}

async function recordMessagesUntilToolUse(input: {
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly entries: Array<ProviderReplayEntry>;
  readonly scenario: string;
  // Returns after the assistant frame carrying this many root tool uses.
  readonly toolUseCount: number;
}): Promise<void> {
  let toolUses = 0;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      throw new Error(`Claude query ended before ${input.scenario} started a tool use.`);
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
    if (replayMessage.type === "result") {
      throw new Error(`Claude query completed before ${input.scenario} started a tool use.`);
    }
    if (sdkMessageHasRootToolUse(replayMessage)) {
      toolUses += 1;
      if (toolUses >= input.toolUseCount) {
        return;
      }
    }
  }
}

// The SDK package may not ship a Claude Code executable for this platform, so
// recordings prefer the installed `claude` binary when it resolves on PATH to
// something the SDK can spawn directly, and otherwise leave the SDK's own
// executable discovery in place. A Windows launcher shim (`claude.cmd` and
// friends) is not directly spawnable, so it only counts when
// resolveClaudeSdkExecutablePath can follow it to a real package entry.
const resolveClaudeRecordingExecutablePath = Effect.fn("resolveClaudeRecordingExecutablePath")(
  function* (environment: NodeJS.ProcessEnv) {
    const resolveExecutable = yield* SpawnExecutableResolution;
    const platform = yield* HostProcessPlatform;
    const resolved = resolveExecutable("claude", platform, environment);
    if (resolved === undefined) {
      return undefined;
    }
    const executablePath = yield* resolveClaudeSdkExecutablePath(resolved, environment);
    if (platform === "win32" && isWindowsClaudeLauncherShimPath(executablePath)) {
      return undefined;
    }
    return executablePath;
  },
);

async function openRecordingQuery(input: Parameters<typeof query>[0]) {
  const executablePath = await Effect.runPromise(resolveClaudeRecordingExecutablePath(process.env));
  return query({
    ...input,
    options: {
      ...input.options,
      ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
    },
  });
}
export {
  sanitizedReplayCwd,
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
  recordMessagesUntilToolUse,
  recordMessagesUntilIteratorDone,
};
