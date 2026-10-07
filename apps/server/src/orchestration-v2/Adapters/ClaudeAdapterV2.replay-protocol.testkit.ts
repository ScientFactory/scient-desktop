import {
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderReplayEntry, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { ProviderAdapterDriverCreateError } from "../ProviderAdapterDriver.ts";

export const CLAUDE_AGENT_SDK_REPLAY_PROTOCOL = "claude-agent-sdk.query" as const;

/**
 * Replay label of the result that ends the Nth (1-based) background wake turn
 * of a recording, so a replay gate can hold it.
 */
export const claudeBackgroundWakeResultLabel = (wakeNumber: number) =>
  `result:background-wake:${wakeNumber}`;

const ClaudeAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(ClaudeAdapterV2.CLAUDE_PROVIDER),
  protocol: Schema.Literal(CLAUDE_AGENT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});

type ClaudeAgentSdkReplayTranscript = typeof ClaudeAgentSdkReplayTranscript.Type;

export class ClaudeReplayTranscriptDecodeError extends Schema.TaggedError<ClaudeReplayTranscriptDecodeError>()(
  "ClaudeReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Claude Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class ClaudeReplayExhaustedError extends Schema.TaggedError<ClaudeReplayExhaustedError>()(
  "ClaudeReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayUnexpectedOutboundError extends Schema.TaggedError<ClaudeReplayUnexpectedOutboundError>()(
  "ClaudeReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unexpected outbound Claude Agent SDK frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayFrameMismatchError extends Schema.TaggedError<ClaudeReplayFrameMismatchError>()(
  "ClaudeReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Outbound Claude Agent SDK frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayRuntimeExitError extends Schema.TaggedError<ClaudeReplayRuntimeExitError>()(
  "ClaudeReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayIncompleteError extends Schema.TaggedError<ClaudeReplayIncompleteError>()(
  "ClaudeReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayDriverError extends Schema.TaggedError<ClaudeReplayDriverError>()(
  "ClaudeReplayDriverError",
  {
    scenario: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay driver failed in scenario ${this.scenario}.`;
  }
}

export const ClaudeAgentSdkReplayError = Schema.Union([
  ClaudeReplayTranscriptDecodeError,
  ClaudeReplayExhaustedError,
  ClaudeReplayUnexpectedOutboundError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayIncompleteError,
  ClaudeReplayDriverError,
]);

export type ClaudeAgentSdkReplayError = typeof ClaudeAgentSdkReplayError.Type;

export const ClaudeOrchestratorReplayHarnessError = Schema.Union([
  ClaudeAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);

export type ClaudeOrchestratorReplayHarnessError = typeof ClaudeOrchestratorReplayHarnessError.Type;

interface ClaudeQueryOpenFrame {
  readonly type: "query.open";
  readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
}

interface ClaudePromptOfferFrame {
  readonly type: "prompt.offer";
  readonly message: SDKUserMessage;
}

interface ClaudeQuerySetModelFrame {
  readonly type: "query.set_model";
  readonly model: string;
}

interface ClaudeQueryInterruptFrame {
  readonly type: "query.interrupt";
}

interface ClaudePermissionRequestFrame {
  readonly type: "permission.request";
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly options: {
    readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
    readonly blockedPath?: string;
    readonly decisionReason?: string;
    readonly title?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly toolUseID: string;
    readonly agentID?: string;
  };
}

interface ClaudePermissionResponseFrame {
  readonly type: "permission.response";
  readonly result: PermissionResult;
}

interface ClaudeSessionForkFrame {
  readonly type: "session.fork";
  readonly sessionId: string;
  readonly options: {
    readonly dir?: string;
    readonly upToMessageId?: string;
    readonly title?: string;
  };
}

interface ClaudeSessionForkedFrame {
  readonly type: "session.forked";
  readonly sessionId: string;
}

interface ClaudeSubagentLookupFrame {
  readonly type: "subagent.lookup";
  readonly sessionId: string;
  readonly agentId: string;
}

interface ClaudeSubagentFoundFrame {
  readonly type: "subagent.found";
  readonly toolUseId: string | null;
}

type ClaudeOutboundFrame =
  | ClaudeQueryOpenFrame
  | ClaudePromptOfferFrame
  | ClaudeQuerySetModelFrame
  | ClaudeQueryInterruptFrame
  | ClaudePermissionResponseFrame
  | ClaudeSessionForkFrame
  | ClaudeSubagentLookupFrame;

interface ClaudeQueryRunner {
  readonly open: (
    input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput,
  ) => ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
  readonly forkSession: (
    input: ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput,
  ) => ClaudeSessionForkedFrame;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAdapterV2.ClaudeAgentSdkSubagentLookupInput,
  ) => string | null;
  readonly assertComplete: () => void;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeContextHandoffText(value: string): string {
  if (!value.startsWith("Context handoff (")) {
    return value;
  }
  const userMessageMarker = "\n\nUser message:\n";
  const userMessageIndex = value.indexOf(userMessageMarker);
  const headerEndIndex = value.indexOf(":\n");
  if (headerEndIndex === -1 || userMessageIndex === -1 || headerEndIndex >= userMessageIndex) {
    return value;
  }
  return `${value.slice(0, headerEndIndex + 2)}<dynamic-summary>${value.slice(userMessageIndex)}`;
}

function normalizeReplayFrame(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeContextHandoffText(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeReplayFrame);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeReplayFrame(entry)]),
  );
}

function sameFrame(left: unknown, right: unknown): boolean {
  return (
    stableStringify(normalizeReplayFrame(left)) === stableStringify(normalizeReplayFrame(right))
  );
}

function isClaudeSdkReplayMessage(frame: unknown): frame is SDKMessage {
  if (typeof frame !== "object" || frame === null) {
    return false;
  }
  const type = Reflect.get(frame, "type");
  return (
    type === "assistant" ||
    type === "user" ||
    type === "result" ||
    type === "system" ||
    type === "stream_event" ||
    type === "rate_limit_event" ||
    // Undeclared in the SDK types: queued/started/completed for each prompt
    // that carries a uuid.
    type === "command_lifecycle"
  );
}

function sdkMessageFromReplayFrame(frame: unknown): SDKMessage {
  if (!isClaudeSdkReplayMessage(frame)) {
    throw new Error("Replay frame is not a Claude Agent SDK message.");
  }
  return frame;
}

function isClaudePermissionRequestFrame(frame: unknown): frame is ClaudePermissionRequestFrame {
  const options =
    typeof frame === "object" && frame !== null ? Reflect.get(frame, "options") : undefined;
  return (
    typeof frame === "object" &&
    frame !== null &&
    Reflect.get(frame, "type") === "permission.request" &&
    typeof Reflect.get(frame, "toolName") === "string" &&
    typeof Reflect.get(frame, "input") === "object" &&
    Reflect.get(frame, "input") !== null &&
    typeof options === "object" &&
    options !== null &&
    typeof Reflect.get(options, "toolUseID") === "string"
  );
}

function makeClaudePermissionResponseFrame(
  result: PermissionResult,
): ClaudePermissionResponseFrame {
  return {
    type: "permission.response",
    result,
  };
}

function permissionRequestOptionsFromFrame(
  frame: ClaudePermissionRequestFrame,
  signal: AbortSignal,
): Parameters<CanUseTool>[2] {
  const options = frame.options;
  return {
    signal,
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
    ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    ...(options.description === undefined ? {} : { description: options.description }),
    toolUseID: options.toolUseID,
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
    requestId: options.toolUseID,
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

function nativeSessionIdFor(transcript: ClaudeAgentSdkReplayTranscript): string {
  const metadataSessionId = transcript.metadata?.nativeSessionId;
  return typeof metadataSessionId === "string"
    ? metadataSessionId
    : "00000000-0000-4000-8000-000000000000";
}

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError);

const isClaudeAgentSdkReplayError = Schema.is(ClaudeAgentSdkReplayError);

function replayQueryRunnerError(
  transcript: ClaudeAgentSdkReplayTranscript,
  cause: unknown,
): ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError {
  if (isClaudeAgentSdkQueryRunnerError(cause)) {
    return cause;
  }
  const replayCause = isClaudeAgentSdkReplayError(cause)
    ? cause
    : new ClaudeReplayDriverError({ scenario: transcript.scenario, cause });
  return new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
    cause: replayCause,
    method: `replay-scenario:${transcript.scenario}`,
  });
}
export {
  type ClaudeQueryOpenFrame,
  type ClaudePromptOfferFrame,
  type ClaudeSessionForkFrame,
  ClaudeAgentSdkReplayTranscript,
  type ClaudeQueryRunner,
  isClaudePermissionRequestFrame,
  permissionRequestOptionsFromFrame,
  makeClaudePermissionResponseFrame,
  sdkMessageFromReplayFrame,
  type ClaudeOutboundFrame,
  sameFrame,
  type ClaudeSessionForkedFrame,
  type ClaudeSubagentFoundFrame,
  replayQueryRunnerError,
  nativeSessionIdFor,
  metadataFromTranscript,
  type ClaudePermissionRequestFrame,
};
