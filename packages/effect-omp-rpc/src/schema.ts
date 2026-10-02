import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** Protocol v2 is the lossless chunked transport. v1 remains a single JSONL frame. */
export const OMP_RPC_PROTOCOL_V2 = 2;
/** Physical JSONL ceiling from OMP's RpcFrameDecoder. Advertised limits cannot raise it. */
export const OMP_HARD_MAX_FRAME_BYTES = 1024 * 1024;
/** Reassembled logical-frame ceiling from OMP's RpcFrameDecoder. */
export const OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
/** Each chunk payload must fit in this many decoded bytes. */
export const OMP_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
export const OMP_RPC_MAX_CHUNK_ID_LENGTH = 128;

export const OmpThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type OmpThinkingLevel = typeof OmpThinkingLevel.Type;

export const OmpRpcImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type OmpRpcImage = typeof OmpRpcImage.Type;

export const OmpRpcReady = Schema.Struct({
  type: Schema.Literal("ready"),
  // OMP 18.x writes the ready frame as v1. A later base version is accepted
  // here; the client still requires v2 to be offered before it negotiates.
  protocolVersion: Schema.Finite,
  supportedProtocolVersions: Schema.Array(Schema.Finite),
  maxFrameBytes: Schema.Finite,
  maxReassembledFrameBytes: Schema.Finite,
});
export type OmpRpcReady = typeof OmpRpcReady.Type;

export const OmpRpcResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});
export type OmpRpcResponse = typeof OmpRpcResponse.Type;

/**
 * Per-model thinking capabilities (`ThinkingConfig` in OMP's catalog). The
 * efforts are ordered least to most intensive; level strings stay open so a new
 * OMP effort cannot fail the whole model list.
 */
export const OmpRpcModelThinking = Schema.Struct({
  mode: Schema.optional(Schema.String),
  efforts: Schema.optional(Schema.Array(Schema.String)),
  defaultLevel: Schema.optional(Schema.String),
  /** The model rejects requests that omit an effort. */
  requiresEffort: Schema.optional(Schema.Boolean),
});
export type OmpRpcModelThinking = typeof OmpRpcModelThinking.Type;

export const OmpRpcModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  // Native discovered-model caches can report null when capacity is unknown.
  contextWindow: Schema.optional(Schema.NullOr(Schema.Number)),
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  // Input kinds stay open ("text", "image", and any later kind such as audio).
  input: Schema.optional(Schema.Array(Schema.String)),
  thinking: Schema.optional(OmpRpcModelThinking),
  /** Legacy field. OMP 18.x sends `thinking.efforts` instead. */
  thinkingLevels: Schema.optional(Schema.Array(Schema.String)),
});
export type OmpRpcModel = typeof OmpRpcModel.Type;

export const OmpRpcAvailableModels = Schema.Struct({
  models: Schema.Array(OmpRpcModel),
});
export type OmpRpcAvailableModels = typeof OmpRpcAvailableModels.Type;

export const OmpRpcCommandDescriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  aliases: Schema.optional(Schema.Array(Schema.String)),
});
export type OmpRpcCommandDescriptor = typeof OmpRpcCommandDescriptor.Type;

export const OmpRpcAvailableCommands = Schema.Struct({
  commands: Schema.Array(OmpRpcCommandDescriptor),
});
export type OmpRpcAvailableCommands = typeof OmpRpcAvailableCommands.Type;

export const OmpSwitchSessionResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type OmpSwitchSessionResult = typeof OmpSwitchSessionResult.Type;

export const OmpNegotiateResult = Schema.Struct({
  protocolVersion: Schema.Literal(2),
});
export type OmpNegotiateResult = typeof OmpNegotiateResult.Type;

export const OmpRpcState = Schema.Struct({
  model: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      id: Schema.String,
    }),
  ),
  thinkingLevel: Schema.optional(Schema.String),
  isStreaming: Schema.optional(Schema.Boolean),
  isCompacting: Schema.optional(Schema.Boolean),
  isSettled: Schema.optional(Schema.Boolean),
  hasPendingAsyncWork: Schema.optional(Schema.Boolean),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  sessionName: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Finite),
});
export type OmpRpcState = typeof OmpRpcState.Type;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const maybeString = Schema.optional(Schema.String);
const maybeBoolean = Schema.optional(Schema.Boolean);
const maybeNumber = Schema.optional(Schema.Finite);
const maybeUnknown = Schema.optional(Schema.Unknown);

/**
 * Failure detail of a `prompt_result` with `status: "error"` (OMP 18.3+).
 * `retryable` marks a transient failure after OMP's own retries.
 */
export const OmpPromptError = Schema.Struct({
  message: Schema.String,
  provider: maybeString,
  model: maybeString,
  httpStatus: maybeNumber,
  retryable: Schema.Boolean,
});
export type OmpPromptError = typeof OmpPromptError.Type;

/**
 * Normalized projection consumed by the server adapter. The client validates
 * the wire frame with `OmpRpcKnownEvent` before constructing this projection;
 * keeping this small structural projection avoids making every adapter branch
 * depend on the complete upstream event union.
 */
export const OmpRpcEvent = Schema.Struct({
  type: Schema.String,
  raw: maybeUnknown,
  id: maybeString,
  isTerminal: maybeBoolean,
  yielded: maybeBoolean,
  agentInvoked: maybeBoolean,
  assistantMessageEvent: maybeUnknown,
  model: maybeUnknown,
  thinkingLevel: maybeString,
  message: maybeUnknown,
  messages: maybeUnknown,
  payload: maybeUnknown,
  toolCallId: maybeString,
  toolName: maybeString,
  name: maybeString,
  args: maybeUnknown,
  isError: maybeBoolean,
  partialResult: maybeUnknown,
  update: maybeUnknown,
  result: maybeUnknown,
  arguments: maybeUnknown,
  output: maybeString,
  text: maybeString,
  delta: maybeString,
  subagentId: maybeString,
  title: maybeString,
  status: maybeString,
  phase: maybeString,
  method: maybeString,
  options: maybeUnknown,
  optionDetails: maybeUnknown,
  placeholder: maybeString,
  prefill: maybeString,
  commands: maybeUnknown,
  sessionFile: maybeString,
  sessionId: maybeString,
  error: maybeString,
  targetId: maybeString,
  url: maybeString,
  launchUrl: maybeString,
  instructions: maybeString,
  operation: maybeString,
  extensionPath: maybeString,
  event: maybeString,
  stopReason: maybeString,
  role: maybeString,
  level: maybeString,
  success: maybeBoolean,
  finalError: maybeString,
  errorMessage: maybeString,
  errorId: maybeNumber,
  attempt: maybeNumber,
  maxAttempts: maybeNumber,
  delayMs: maybeNumber,
  retryErrors: maybeUnknown,
  skipped: maybeBoolean,
  sessionSettled: maybeBoolean,
  /** `prompt_result.error`, renamed because `error` is a string on other events. */
  promptError: Schema.optional(OmpPromptError),
  aborted: maybeBoolean,
  willRetry: maybeBoolean,
  content: maybeUnknown,
});
export type OmpRpcEvent = typeof OmpRpcEvent.Type;

export const OmpAgentMessage = Schema.Struct({
  role: Schema.String,
  /** A `custom` message's kind, for example `async-result` for a background job's result. */
  customType: maybeString,
  content: Schema.optional(Schema.Unknown),
  stopReason: maybeString,
  /** Provider failure text on an assistant message with `stopReason` `error` or `aborted`. */
  errorMessage: maybeString,
  /** OMP's numeric error classifier (for example 16781312 for a 401). */
  errorId: maybeNumber,
  /** HTTP status of a failed provider request. */
  errorStatus: maybeNumber,
  isError: maybeBoolean,
});
export type OmpAgentMessage = typeof OmpAgentMessage.Type;

export const OmpMessageStartEvent = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: OmpAgentMessage,
});
export type OmpMessageStartEvent = typeof OmpMessageStartEvent.Type;

export const OmpMessageUpdateEvent = Schema.Struct({
  type: Schema.Literal("message_update"),
  message: OmpAgentMessage,
  assistantMessageEvent: Schema.Unknown,
});
export type OmpMessageUpdateEvent = typeof OmpMessageUpdateEvent.Type;

export const OmpMessageEndEvent = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: OmpAgentMessage,
});
export type OmpMessageEndEvent = typeof OmpMessageEndEvent.Type;

export const OmpAgentStartEvent = Schema.Struct({ type: Schema.Literal("agent_start") });
export type OmpAgentStartEvent = typeof OmpAgentStartEvent.Type;

export const OmpAgentEndEvent = Schema.Struct({
  type: Schema.Literal("agent_end"),
  messages: Schema.Array(Schema.Unknown),
  /** `false` means OMP has scheduled more work before the run truly settles. */
  isTerminal: maybeBoolean,
  /** OMP 18.3+: `false` while the agent continues its own work (retry, compaction). */
  yielded: maybeBoolean,
});
export type OmpAgentEndEvent = typeof OmpAgentEndEvent.Type;

export const OmpTurnStartEvent = Schema.Struct({ type: Schema.Literal("turn_start") });
export type OmpTurnStartEvent = typeof OmpTurnStartEvent.Type;

export const OmpTurnEndEvent = Schema.Struct({
  type: Schema.Literal("turn_end"),
  message: OmpAgentMessage,
  toolResults: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type OmpTurnEndEvent = typeof OmpTurnEndEvent.Type;

export const OmpToolExecutionStartEvent = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: maybeUnknown,
  arguments: maybeUnknown,
  intent: maybeString,
});
export type OmpToolExecutionStartEvent = typeof OmpToolExecutionStartEvent.Type;

export const OmpToolExecutionUpdateEvent = Schema.Struct({
  type: Schema.Literal("tool_execution_update"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: maybeUnknown,
  arguments: maybeUnknown,
  partialResult: maybeUnknown,
});
export type OmpToolExecutionUpdateEvent = typeof OmpToolExecutionUpdateEvent.Type;

export const OmpToolExecutionEndEvent = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.Unknown,
  isError: maybeBoolean,
});
export type OmpToolExecutionEndEvent = typeof OmpToolExecutionEndEvent.Type;

export const OmpToolStreamUpdateEvent = Schema.Struct({
  type: Schema.Literal("tool_stream_update"),
  toolCallId: Schema.String,
  toolName: maybeString,
  update: Schema.Unknown,
});
export type OmpToolStreamUpdateEvent = typeof OmpToolStreamUpdateEvent.Type;

export const OmpPromptResultEvent = Schema.Struct({
  type: Schema.Literal("prompt_result"),
  id: maybeString,
  agentInvoked: Schema.Boolean,
  /** OMP 18.3+: "completed", "aborted", or "error". */
  status: maybeString,
  /** OMP 18.3+: whether nothing can wake the session again. */
  sessionSettled: maybeBoolean,
  /** OMP 18.3+: present with `status: "error"`. */
  error: Schema.optional(OmpPromptError),
});
export type OmpPromptResultEvent = typeof OmpPromptResultEvent.Type;

/** OMP 18.3+: the session went quiet after agent activity. */
export const OmpSessionSettledEvent = Schema.Struct({ type: Schema.Literal("session_settled") });
export type OmpSessionSettledEvent = typeof OmpSessionSettledEvent.Type;

export const OmpAvailableCommandsUpdateEvent = Schema.Struct({
  type: Schema.Literal("available_commands_update"),
  commands: Schema.Array(OmpRpcCommandDescriptor),
});
export type OmpAvailableCommandsUpdateEvent = typeof OmpAvailableCommandsUpdateEvent.Type;

export const OmpSessionInfoUpdateEvent = Schema.Struct({
  type: Schema.Literal("session_info_update"),
  sessionFile: maybeString,
  sessionId: maybeString,
});
export type OmpSessionInfoUpdateEvent = typeof OmpSessionInfoUpdateEvent.Type;

export const OmpExtensionErrorEvent = Schema.Struct({
  type: Schema.Literal("extension_error"),
  error: Schema.String,
  extensionPath: maybeString,
  event: maybeString,
});
export type OmpExtensionErrorEvent = typeof OmpExtensionErrorEvent.Type;

export const OmpHostToolCall = Schema.Struct({
  type: Schema.Literal("host_tool_call"),
  id: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  arguments: Schema.Unknown,
});
export type OmpHostToolCall = typeof OmpHostToolCall.Type;

export const OmpHostToolCancel = Schema.Struct({
  type: Schema.Literal("host_tool_cancel"),
  id: maybeString,
  targetId: Schema.String,
});
export type OmpHostToolCancel = typeof OmpHostToolCancel.Type;

export const OmpHostToolResult = Schema.Struct({
  type: Schema.Literal("host_tool_result"),
  id: Schema.String,
  isError: maybeBoolean,
  result: Schema.Unknown,
});
export type OmpHostToolResult = typeof OmpHostToolResult.Type;

export const OmpHostUriRequest = Schema.Struct({
  type: Schema.Literal("host_uri_request"),
  id: Schema.String,
  // "read" or "write" today. An unknown operation must still reach the host so
  // it can answer with an error instead of leaving the request unanswered.
  operation: Schema.String,
  url: Schema.String,
  content: maybeString,
});
export type OmpHostUriRequest = typeof OmpHostUriRequest.Type;

export const OmpHostUriCancel = Schema.Struct({
  type: Schema.Literal("host_uri_cancel"),
  id: maybeString,
  targetId: Schema.String,
});
export type OmpHostUriCancel = typeof OmpHostUriCancel.Type;

export const OmpHostUriResult = Schema.Struct({
  type: Schema.Literal("host_uri_result"),
  id: Schema.String,
  isError: maybeBoolean,
  error: maybeString,
  content: maybeString,
  contentType: maybeString,
  notes: maybeUnknown,
});
export type OmpHostUriResult = typeof OmpHostUriResult.Type;

export const OmpExtensionUiRequest = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: maybeString,
  method: Schema.String,
  title: maybeString,
  message: maybeString,
  placeholder: maybeString,
  prefill: maybeString,
  options: maybeUnknown,
  optionDetails: maybeUnknown,
  targetId: maybeString,
  url: maybeString,
  launchUrl: maybeString,
  instructions: maybeString,
  widgetKey: maybeString,
  widgetLines: maybeUnknown,
  widgetPlacement: maybeString,
  notifyType: maybeString,
});
export type OmpExtensionUiRequest = typeof OmpExtensionUiRequest.Type;

export const OmpSubagentProgress = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  description: maybeString,
});
export type OmpSubagentProgress = typeof OmpSubagentProgress.Type;

export const OmpSubagentLifecyclePayload = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  agent: maybeString,
  agentSource: maybeString,
  description: maybeString,
  index: Schema.optional(Schema.Finite),
  parentToolCallId: maybeString,
  sessionFile: maybeString,
});
export type OmpSubagentLifecyclePayload = typeof OmpSubagentLifecyclePayload.Type;

export const OmpSubagentProgressPayload = Schema.Struct({
  index: Schema.optional(Schema.Finite),
  agent: maybeString,
  agentSource: maybeString,
  task: maybeString,
  assignment: maybeString,
  parentToolCallId: maybeString,
  sessionFile: maybeString,
  progress: OmpSubagentProgress,
});
export type OmpSubagentProgressPayload = typeof OmpSubagentProgressPayload.Type;

export const OmpSubagentFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subagent_lifecycle"),
    payload: OmpSubagentLifecyclePayload,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_progress"),
    payload: OmpSubagentProgressPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_event"),
    payload: Schema.Unknown,
  }),
]);
export type OmpSubagentFrame = typeof OmpSubagentFrame.Type;

const OmpLifecycleEvent = Schema.Struct({
  type: Schema.Literals([
    "auto_compaction_start",
    "auto_compaction_end",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "retry_fallback_applied",
    "retry_fallback_succeeded",
    "config_update",
    "config_warnings_changed",
    "advisor_cost_changed",
    "advisor_yielded",
    "ttsr_triggered",
    "todo_reminder",
    "todo_auto_clear",
    "notice",
    "goal_updated",
    "model_changed",
    "thinking_level_changed",
    "command_output",
  ]),
  aborted: maybeBoolean,
  willRetry: maybeBoolean,
  output: maybeString,
  text: maybeString,
  // Model failures (401, 429, unknown model) are reported as an error notice
  // or a failed auto-retry. Keep those fields so the host can name the cause.
  level: maybeString,
  message: maybeString,
  success: maybeBoolean,
  finalError: maybeString,
  // auto_retry_start and auto_compaction_end report their cause as
  // `errorMessage`; auto_retry_* carry the attempt counters.
  errorMessage: maybeString,
  errorId: maybeNumber,
  attempt: maybeNumber,
  maxAttempts: maybeNumber,
  delayMs: maybeNumber,
  /** auto_retry_end: the superseded or recovered attempts. */
  retryErrors: Schema.optional(Schema.Array(Schema.Unknown)),
  /** auto_compaction_end: compaction was skipped for a benign reason. */
  skipped: maybeBoolean,
  result: maybeUnknown,
  /** thinking_level_changed: the effective level; absent when the model has none. */
  thinkingLevel: maybeString,
});
export type OmpLifecycleEvent = typeof OmpLifecycleEvent.Type;

export const OmpRpcKnownEvent = Schema.Union([
  OmpAgentStartEvent,
  OmpAgentEndEvent,
  OmpTurnStartEvent,
  OmpTurnEndEvent,
  OmpMessageStartEvent,
  OmpMessageUpdateEvent,
  OmpMessageEndEvent,
  OmpToolExecutionStartEvent,
  OmpToolExecutionUpdateEvent,
  OmpToolExecutionEndEvent,
  OmpToolStreamUpdateEvent,
  OmpPromptResultEvent,
  OmpSessionSettledEvent,
  OmpAvailableCommandsUpdateEvent,
  OmpSessionInfoUpdateEvent,
  OmpExtensionUiRequest,
  OmpExtensionErrorEvent,
  OmpHostToolCall,
  OmpHostToolCancel,
  OmpHostToolResult,
  OmpHostUriRequest,
  OmpHostUriCancel,
  OmpHostUriResult,
  OmpSubagentFrame,
  OmpLifecycleEvent,
]);
export type OmpRpcKnownEvent = typeof OmpRpcKnownEvent.Type;

const eventTypeLiterals = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  if (SchemaAST.isUnion(ast)) return ast.types.flatMap(eventTypeLiterals);
  if (SchemaAST.isLiteral(ast)) return typeof ast.literal === "string" ? [ast.literal] : [];
  if (SchemaAST.isObjects(ast)) {
    const type = ast.propertySignatures.find((property) => property.name === "type");
    return type ? eventTypeLiterals(type.type) : [];
  }
  return [];
};

/**
 * Every event type this client decodes, read from `OmpRpcKnownEvent` so the
 * list cannot drift from the schema. Hosts pin it with `set_event_filter`.
 */
export const OMP_KNOWN_EVENT_TYPES: ReadonlyArray<string> = Array.from(
  new Set(eventTypeLiterals(OmpRpcKnownEvent.ast)),
);

export const OmpEventFilterResult = Schema.Struct({
  events: Schema.NullOr(Schema.Array(Schema.String)),
});
export type OmpEventFilterResult = typeof OmpEventFilterResult.Type;

export const OmpHostToolDefinition = Schema.Struct({
  name: Schema.String,
  label: Schema.optional(Schema.String),
  description: Schema.String,
  parameters: Schema.Unknown,
  hidden: Schema.optional(Schema.Boolean),
  loadMode: Schema.optional(Schema.Literals(["essential", "discoverable"])),
  readsSkillUris: Schema.optional(Schema.Boolean),
});
export type OmpHostToolDefinition = typeof OmpHostToolDefinition.Type;

export const OmpHostUriSchemeDefinition = Schema.Struct({
  scheme: Schema.String,
  description: Schema.optional(Schema.String),
  writable: Schema.optional(Schema.Boolean),
  immutable: Schema.optional(Schema.Boolean),
});
export type OmpHostUriSchemeDefinition = typeof OmpHostUriSchemeDefinition.Type;
