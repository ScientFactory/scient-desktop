import * as Schema from "effect/Schema";

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
  protocolVersion: Schema.Literal(1),
  supportedProtocolVersions: Schema.Array(Schema.Literals([1, 2])),
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

export const OmpRpcModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
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
const maybeUnknown = Schema.optional(Schema.Unknown);

/**
 * One decoded stdout event. Excess fields are ignored. Response frames use
 * `OmpRpcResponse` instead, and a failed decode of a response is fatal.
 */
export const OmpRpcEvent = Schema.Struct({
  type: Schema.String,
  id: maybeString,
  isTerminal: maybeBoolean,
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
  isError: maybeBoolean,
  partialResult: maybeUnknown,
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
  operation: maybeString,
  extensionPath: maybeString,
  event: maybeString,
  stopReason: maybeString,
  role: maybeString,
  aborted: maybeBoolean,
  willRetry: maybeBoolean,
  content: maybeUnknown,
});
export type OmpRpcEvent = typeof OmpRpcEvent.Type;

export const OmpAgentMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  stopReason: maybeString,
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

export const OmpAgentEndEvent = Schema.Struct({
  type: Schema.Literal("agent_end"),
  messages: Schema.Array(Schema.Unknown),
  isTerminal: maybeBoolean,
});
export type OmpAgentEndEvent = typeof OmpAgentEndEvent.Type;

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
  result: maybeUnknown,
});
export type OmpHostToolResult = typeof OmpHostToolResult.Type;

export const OmpHostUriRequest = Schema.Struct({
  type: Schema.Literal("host_uri_request"),
  id: Schema.String,
  operation: Schema.Literals(["read", "write"]),
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
});
export type OmpHostUriResult = typeof OmpHostUriResult.Type;

export const OmpExtensionUiRequest = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.String,
  title: maybeString,
  message: maybeString,
  placeholder: maybeString,
  prefill: maybeString,
  options: maybeUnknown,
  optionDetails: maybeUnknown,
  targetId: maybeString,
});
export type OmpExtensionUiRequest = typeof OmpExtensionUiRequest.Type;

export const OmpExtensionUiResponse = Schema.Struct({
  type: Schema.Literal("extension_ui_response"),
  id: Schema.String,
  value: maybeString,
  confirmed: maybeBoolean,
  cancelled: maybeBoolean,
});
export type OmpExtensionUiResponse = typeof OmpExtensionUiResponse.Type;

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
  index: Schema.Finite,
  parentToolCallId: maybeString,
  sessionFile: maybeString,
});
export type OmpSubagentLifecyclePayload = typeof OmpSubagentLifecyclePayload.Type;

export const OmpSubagentProgressPayload = Schema.Struct({
  index: Schema.Finite,
  agent: Schema.String,
  agentSource: Schema.String,
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

export const OmpHostToolUpdate = Schema.Struct({
  type: Schema.Literal("host_tool_update"),
  id: Schema.String,
  partialResult: Schema.Unknown,
});
export type OmpHostToolUpdate = typeof OmpHostToolUpdate.Type;
