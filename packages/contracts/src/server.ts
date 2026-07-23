import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ModelSelection, ProviderKind, ProviderStartOptions } from "./orchestration";
import { ServerSettings, ServerSettingsPatch } from "./settings";
import { ExecutionEnvironmentDescriptor } from "./environment";
import { AutomationCompletionPolicy, AutomationMode, AutomationSchedule } from "./automation";

const SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BASE64_CHARS = 14_000_000;

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderRuntimeSource = Schema.Literals([
  "custom",
  "system",
  "managed",
  "bundled",
  "missing",
]);
export type ServerProviderRuntimeSource = typeof ServerProviderRuntimeSource.Type;

export const ServerProviderInstallationStatus = Schema.Literals([
  "resolving",
  "awaiting_consent",
  "downloading",
  "verifying",
  "installing",
  "smoke_testing",
  "installed",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ServerProviderInstallationStatus = typeof ServerProviderInstallationStatus.Type;

export const ServerProviderInstallationState = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  operation: Schema.Literals(["install", "repair", "rollback", "remove"]),
  status: ServerProviderInstallationStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: TrimmedNonEmptyString,
  version: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  bytesDownloaded: Schema.optionalKey(NonNegativeInt),
  totalBytes: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type ServerProviderInstallationState = typeof ServerProviderInstallationState.Type;

export const ServerProviderRuntimeState = Schema.Struct({
  source: ServerProviderRuntimeSource,
  managedVersion: Schema.NullOr(TrimmedNonEmptyString),
  canInstall: Schema.Boolean,
  canRepair: Schema.Boolean,
  canRollback: Schema.Boolean,
  canRemove: Schema.Boolean,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderRuntimeState = typeof ServerProviderRuntimeState.Type;

export const ServerProviderConnectionMethod = Schema.Literals([
  "codex_browser",
  "claude_account",
  "claude_sso",
  "claude_console",
  // Retained for wire compatibility with older transient status snapshots.
  // ProviderConnection no longer accepts this method for new operations.
  "claude_subscription",
  "cursor_browser",
  "antigravity_browser",
  "grok_browser",
  "droid_device_pairing",
]);
export type ServerProviderConnectionMethod = typeof ServerProviderConnectionMethod.Type;

export const ServerProviderConnectionState = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  method: ServerProviderConnectionMethod,
  status: Schema.Literals([
    "starting",
    "waiting_for_browser",
    "verifying",
    "connected",
    "failed",
    "cancelled",
  ]),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: TrimmedNonEmptyString,
  authorizationUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
});
export type ServerProviderConnectionState = typeof ServerProviderConnectionState.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  // `false` means this runtime owns authentication outside the provider's
  // account flow (for example a custom Codex model provider). Older servers
  // omit the field, so clients retain their provider-specific default.
  requiresProviderAccount: Schema.optional(Schema.Boolean),
  authType: Schema.optional(TrimmedNonEmptyString),
  authLabel: Schema.optional(TrimmedNonEmptyString),
  voiceTranscriptionAvailable: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  versionAdvisory: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["unknown", "current", "behind_latest"]),
      currentVersion: Schema.NullOr(TrimmedNonEmptyString),
      latestVersion: Schema.NullOr(TrimmedNonEmptyString),
      updateCommand: Schema.NullOr(TrimmedNonEmptyString),
      canUpdate: Schema.Boolean,
      checkedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  updateState: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["idle", "queued", "running", "succeeded", "failed", "unchanged"]),
      startedAt: Schema.NullOr(IsoDateTime),
      finishedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
      output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
    }),
  ),
  runtime: Schema.optionalKey(ServerProviderRuntimeState),
  installationState: Schema.optionalKey(ServerProviderInstallationState),
  connectionState: Schema.optionalKey(ServerProviderConnectionState),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

/**
 * Complete provider status projected for current client-facing RPC boundaries.
 *
 * `ServerProviderStatus` intentionally keeps `runtime` optional while older web
 * and server builds can still meet over the local WebSocket transport. Current
 * servers must project this complete shape before publishing provider status to
 * clients so refreshes cannot erase managed-install capabilities.
 */
export const ServerProviderClientStatus = Schema.Struct({
  ...ServerProviderStatus.fields,
  runtime: ServerProviderRuntimeState,
});
export type ServerProviderClientStatus = typeof ServerProviderClientStatus.Type;

export const ServerProviderClientStatuses = Schema.Array(ServerProviderClientStatus);

export type ServerProviderVersionAdvisory = NonNullable<ServerProviderStatus["versionAdvisory"]>;
export type ServerProviderUpdateState = NonNullable<ServerProviderStatus["updateState"]>;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  worktreesDir: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerManagedWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ServerManagedWorktree = typeof ServerManagedWorktree.Type;

export const ServerListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(ServerManagedWorktree),
});
export type ServerListWorktreesResult = typeof ServerListWorktreesResult.Type;

export const ServerProviderUsageLimit = Schema.Struct({
  window: TrimmedNonEmptyString,
  usedPercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageLimit = typeof ServerProviderUsageLimit.Type;

export const ServerProviderUsageLine = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
  subtitle: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageLine = typeof ServerProviderUsageLine.Type;

// Lifecycle of a live provider usage fetch. Absent status is treated as "ok" so
// existing local-archive snapshots stay valid without setting it.
//   ok          – fetched fresh usage from the provider backend
//   needs-auth  – no/expired credential, or the backend rejected the token (read-only mode never refreshes)
//   unsupported – the provider has no fetchable usage source for the current auth (e.g. API-key-only)
//   error       – the fetch failed unexpectedly (network/parse); detail carries the reason
export const ProviderUsageStatus = Schema.Literals(["ok", "needs-auth", "unsupported", "error"]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

export const ServerProviderUsageSnapshot = Schema.Struct({
  provider: ProviderKind,
  updatedAt: IsoDateTime,
  limits: Schema.Array(ServerProviderUsageLimit),
  usageLines: Schema.Array(ServerProviderUsageLine),
  source: TrimmedNonEmptyString,
  status: Schema.optional(ProviderUsageStatus),
  planName: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const ServerGetProviderUsageSnapshotInput = Schema.Struct({
  provider: ProviderKind,
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerGetProviderUsageSnapshotInput = typeof ServerGetProviderUsageSnapshotInput.Type;

export const ServerGetProviderUsageSnapshotResult = Schema.NullOr(ServerProviderUsageSnapshot);
export type ServerGetProviderUsageSnapshotResult = typeof ServerGetProviderUsageSnapshotResult.Type;

// Batch live-usage fetch for supported providers, powering the Settings → Usage section and
// provider-scoped usage chips. Unfiltered requests return one entry per supported provider
// (including needs-auth/error) so the UI can render a row each.
export const ServerListProviderUsageInput = Schema.Struct({
  forceRefresh: Schema.optional(Schema.Boolean),
  provider: Schema.optional(ProviderKind),
});
export type ServerListProviderUsageInput = typeof ServerListProviderUsageInput.Type;

export const ServerListProviderUsageResult = Schema.Array(ServerProviderUsageSnapshot);
export type ServerListProviderUsageResult = typeof ServerListProviderUsageResult.Type;

export const ServerLocalServerAddress = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  family: Schema.Literals(["tcp4", "tcp6", "tcp"]),
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerLocalServerAddress = typeof ServerLocalServerAddress.Type;

export const ServerLocalServerProcess = Schema.Struct({
  id: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: Schema.optional(PositiveInt),
  command: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  pageTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  // Working directory of the listening process, when resolvable. Surfaced in the
  // UI and used to attribute manually-started dev servers to a project by folder.
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  args: Schema.String.check(Schema.isMaxLength(1_000)),
  ports: Schema.Array(PositiveInt),
  addresses: Schema.Array(ServerLocalServerAddress),
  isStoppable: Schema.Boolean,
  stopDisabledReason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerLocalServerProcess = typeof ServerLocalServerProcess.Type;

export const ServerListLocalServersResult = Schema.Struct({
  generatedAt: IsoDateTime,
  servers: Schema.Array(ServerLocalServerProcess),
});
export type ServerListLocalServersResult = typeof ServerListLocalServersResult.Type;

export const ServerStopLocalServerInput = Schema.Struct({
  pid: PositiveInt,
  port: PositiveInt,
});
export type ServerStopLocalServerInput = typeof ServerStopLocalServerInput.Type;

export const ServerStopLocalServerResult = Schema.Struct({
  pid: PositiveInt,
  stopped: Schema.Boolean,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerStopLocalServerResult = typeof ServerStopLocalServerResult.Type;

export const ServerDiagnosticsMemory = Schema.Struct({
  rssBytes: NonNegativeInt,
  heapTotalBytes: NonNegativeInt,
  heapUsedBytes: NonNegativeInt,
  externalBytes: NonNegativeInt,
  arrayBuffersBytes: NonNegativeInt,
});
export type ServerDiagnosticsMemory = typeof ServerDiagnosticsMemory.Type;

export const ServerDiagnosticsChildProcess = Schema.Struct({
  pid: NonNegativeInt,
  ppid: NonNegativeInt,
  rssBytes: NonNegativeInt,
  virtualSizeBytes: NonNegativeInt,
  command: Schema.String,
  args: Schema.String,
});
export type ServerDiagnosticsChildProcess = typeof ServerDiagnosticsChildProcess.Type;

export const ServerDiagnosticsResult = Schema.Struct({
  generatedAt: IsoDateTime,
  process: Schema.Struct({
    pid: NonNegativeInt,
    uptimeSeconds: NonNegativeInt,
    memory: ServerDiagnosticsMemory,
  }),
  childProcesses: Schema.Array(ServerDiagnosticsChildProcess),
  childProcessTotalCount: NonNegativeInt,
  childProcessTotalRssBytes: NonNegativeInt,
  projection: Schema.Struct({
    projectCount: NonNegativeInt,
    threadCount: NonNegativeInt,
  }),
});
export type ServerDiagnosticsResult = typeof ServerDiagnosticsResult.Type;

export const VoiceTranscriptionMode = Schema.Literals(["automatic", "offline-only"]);
export type VoiceTranscriptionMode = typeof VoiceTranscriptionMode.Type;

export const ServerVoiceTranscriptionInput = Schema.Struct({
  // Kept optional during the provider-neutral migration so older clients and
  // servers can interoperate. Voice routing no longer follows the text provider.
  provider: Schema.optionalKey(ProviderKind),
  mode: Schema.optionalKey(VoiceTranscriptionMode),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sampleRateHz: NonNegativeInt,
  durationMs: NonNegativeInt,
  audioBase64: TrimmedNonEmptyString.check(
    Schema.isMaxLength(SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BASE64_CHARS),
  ),
});
export type ServerVoiceTranscriptionInput = typeof ServerVoiceTranscriptionInput.Type;

export const ServerVoiceTranscriptionResult = Schema.Struct({
  text: TrimmedNonEmptyString,
  engine: Schema.optionalKey(Schema.Literals(["chatgpt", "local"])),
  fallbackUsed: Schema.optionalKey(Schema.Boolean),
  fallbackReason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerVoiceTranscriptionResult = typeof ServerVoiceTranscriptionResult.Type;

// Compact, stateless recap generation. The caller owns debounce/cache policy so
// this endpoint never participates in the hot transcript projection path.
export const ServerGenerateThreadRecapInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  previousRecap: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
  newMaterial: Schema.String.check(Schema.isMaxLength(16_000)),
  currentState: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type ServerGenerateThreadRecapInput = typeof ServerGenerateThreadRecapInput.Type;

export const ServerGenerateThreadRecapResult = Schema.Struct({
  recap: TrimmedNonEmptyString,
});
export type ServerGenerateThreadRecapResult = typeof ServerGenerateThreadRecapResult.Type;

// Schema-validated automation intent extraction for composer-triggered creation.
// The UI still owns confirmation/error copy; this result only describes what the model understood.
export const ServerAutomationIntentMissingField = Schema.Literals([
  "schedule",
  "taskPrompt",
  "name",
  "mode",
]);
export type ServerAutomationIntentMissingField = typeof ServerAutomationIntentMissingField.Type;

export const ServerGenerateAutomationIntentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  defaultMode: Schema.optional(AutomationMode),
  nowIso: IsoDateTime,
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type ServerGenerateAutomationIntentInput = typeof ServerGenerateAutomationIntentInput.Type;

export const ServerGenerateAutomationIntentResult = Schema.Struct({
  isAutomation: Schema.Boolean,
  confidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  language: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  name: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  taskPrompt: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64_000))),
  schedule: Schema.NullOr(AutomationSchedule),
  mode: Schema.NullOr(AutomationMode),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  completionPolicy: Schema.optional(AutomationCompletionPolicy).pipe(
    Schema.withDecodingDefault(() => ({ type: "none" as const })),
  ),
  missingFields: Schema.Array(ServerAutomationIntentMissingField),
  needsConfirmation: Schema.Boolean,
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerGenerateAutomationIntentResult = typeof ServerGenerateAutomationIntentResult.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerProviderStatusesUpdatedPayload = Schema.Struct({
  providers: ServerProviderStatuses,
});
export type ServerProviderStatusesUpdatedPayload = typeof ServerProviderStatusesUpdatedPayload.Type;

export const ServerSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerSettingsUpdatedPayload = typeof ServerSettingsUpdatedPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("welcome"),
    payload: ServerLifecycleWelcomePayload,
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    payload: Schema.Struct({
      at: IsoDateTime,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("maintenance"),
    payload: Schema.Struct({
      task: Schema.Literal("thread-retention"),
      state: Schema.Literals(["started", "progress", "completed", "failed"]),
      at: IsoDateTime,
      deletedCount: Schema.optional(Schema.Number),
      totalCount: Schema.optional(Schema.Number),
      error: Schema.optional(Schema.String),
    }),
  }),
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    config: ServerConfig,
  }),
  Schema.Struct({
    type: Schema.Literal("configUpdated"),
    payload: ServerConfigUpdatedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("providerStatuses"),
    payload: ServerProviderStatusesUpdatedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("settingsUpdated"),
    payload: ServerSettingsUpdatedPayload,
  }),
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerRefreshProvidersResult = ServerProviderStatusesUpdatedPayload;
export type ServerRefreshProvidersResult = typeof ServerRefreshProvidersResult.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderKind,
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedErrorClass<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderKind,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ServerProviderUpdateResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderUpdateResult = typeof ServerProviderUpdateResult.Type;

export const ServerProviderInstallInput = Schema.Struct({
  provider: ProviderKind,
  planToken: TrimmedNonEmptyString,
});
export type ServerProviderInstallInput = typeof ServerProviderInstallInput.Type;

export const ServerProviderInstallCancelInput = Schema.Struct({
  provider: ProviderKind,
  operationId: TrimmedNonEmptyString,
});
export type ServerProviderInstallCancelInput = typeof ServerProviderInstallCancelInput.Type;

export const ServerProviderRuntimeMutationInput = Schema.Struct({
  provider: ProviderKind,
});
export type ServerProviderRuntimeMutationInput = typeof ServerProviderRuntimeMutationInput.Type;

export const ServerProviderInstallPlanInput = Schema.Struct({
  provider: ProviderKind,
});
export type ServerProviderInstallPlanInput = typeof ServerProviderInstallPlanInput.Type;

export const ServerProviderInstallPlan = Schema.Struct({
  provider: ProviderKind,
  planToken: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  sourceHost: TrimmedNonEmptyString,
  downloadBytes: Schema.NullOr(NonNegativeInt),
  expiresAt: IsoDateTime,
});
export type ServerProviderInstallPlan = typeof ServerProviderInstallPlan.Type;
export const ServerProviderInstallPlanResult = ServerProviderInstallPlan;
export type ServerProviderInstallPlanResult = typeof ServerProviderInstallPlanResult.Type;

export class ServerProviderInstallationError extends Schema.TaggedErrorClass<ServerProviderInstallationError>()(
  "ServerProviderInstallationError",
  {
    provider: ProviderKind,
    reason: Schema.Literals([
      "unsupported_provider",
      "unsupported_target",
      "already_running",
      "operation_not_found",
      "download_failed",
      "verification_failed",
      "installation_failed",
      "rollback_unavailable",
      "managed_runtime_unavailable",
      "provider_disabled",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ServerProviderInstallationResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderInstallationResult = typeof ServerProviderInstallationResult.Type;

export const ServerProviderConnectionStartInput = Schema.Struct({
  provider: ProviderKind,
  method: ServerProviderConnectionMethod,
  mode: Schema.optional(Schema.Literals(["connect", "reauthenticate"])),
});
export type ServerProviderConnectionStartInput = typeof ServerProviderConnectionStartInput.Type;

export const ServerProviderConnectionCancelInput = Schema.Struct({
  provider: ProviderKind,
  operationId: TrimmedNonEmptyString,
});
export type ServerProviderConnectionCancelInput = typeof ServerProviderConnectionCancelInput.Type;

export const ServerProviderConnectionAuthorizationCode = Schema.redact(
  TrimmedNonEmptyString.check(
    Schema.isMinLength(8),
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^[A-Za-z0-9._~+/=-]+$/),
  ),
);

export const ServerProviderConnectionSubmitAuthorizationCodeInput = Schema.Struct({
  provider: ProviderKind,
  operationId: TrimmedNonEmptyString,
  authorizationCode: ServerProviderConnectionAuthorizationCode,
});
export type ServerProviderConnectionSubmitAuthorizationCodeInput =
  typeof ServerProviderConnectionSubmitAuthorizationCodeInput.Type;

export class ServerProviderConnectionError extends Schema.TaggedErrorClass<ServerProviderConnectionError>()(
  "ServerProviderConnectionError",
  {
    provider: ProviderKind,
    reason: Schema.Literals([
      "unsupported_provider",
      "provider_not_installed",
      "invalid_method",
      "already_running",
      "operation_not_found",
      "authorization_code_not_supported",
      "authorization_code_already_submitted",
      "authorization_code_not_accepted",
      "provider_disabled",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ServerProviderConnectionResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderConnectionResult = typeof ServerProviderConnectionResult.Type;

export const ServerGetSettingsResult = ServerSettings;
export type ServerGetSettingsResult = typeof ServerGetSettingsResult.Type;

export const ServerGetEnvironmentResult = ExecutionEnvironmentDescriptor;
export type ServerGetEnvironmentResult = typeof ServerGetEnvironmentResult.Type;

export const ServerUpdateSettingsInput = ServerSettingsPatch;
export type ServerUpdateSettingsInput = typeof ServerUpdateSettingsInput.Type;

export const ServerUpdateSettingsResult = ServerSettings;
export type ServerUpdateSettingsResult = typeof ServerUpdateSettingsResult.Type;
