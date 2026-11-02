import {
  ANALYTICS_CONTRACT_REVISION,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_SCHEMA_VERSION,
  normalizedKeys,
  normalizeInheritedEvent,
} from "./contract.ts";

const context = { appVersion: "0.6.8", buildChannel: "stable" } as const;
const representativeProperties = {
  provider: "antigravity",
  usageStatus: "complete",
  inputTokens: 1500,
  outputTokens: 100,
  cachedInputTokens: 500,
  reasoningTokens: 50,
  hasSubagents: false,
  category: "browser",
  section: "synced-folders",
  feature: "search",
  metric: "tokens",
  window: "7",
  breakdown: "model",
  model: "gpt-5.6-sol",
  runtimeMode: "full-access",
  interactionMode: "plan",
  hasResumeCursor: true,
  hasCwd: true,
  hasModel: true,
  strategy: "adopt-existing",
  sessionCount: 4,
  attachmentCount: 1,
  hasInput: true,
  usedTools: true,
  hasAttachment: true,
  durationMs: 12_000,
  audioDurationMs: 9_000,
  shutdownClass: "graceful",
  platform: "macos",
  architecture: "arm64",
  decision: "accept",
  turns: 2,
  method: "picker",
  projectState: "existing",
  initializationState: "initialized",
  outcome: "completed",
  filesCreated: 3,
  creationSource: "new",
  workspaceMode: "local",
  boundaryClass: "checkpoint",
  refork: true,
  engineClass: "local-whisper",
  languageMode: "automatic",
  surface: "preview",
  setting: "direction",
  value: "rtl",
  source: "scient_managed",
  state: "ready",
  installed: true,
  fromInstalled: false,
  toInstalled: true,
  action: "repair",
  stage: "downloading",
  failureClass: "permission",
  component: "server",
  operation: "startup",
  queuedCount: 8,
  droppedCount: 2,
  retryCount: 1,
  deliveryClass: "network",
  operationKind: "latex-build",
  trigger: "agent",
  reviewRequired: true,
  threadCount: 84,
  projectCount: 6,
  ownerSource: "openai",
  ownerId: "9f2c47a1b0d3e6f58c1a7e4d92b03f6a15d8c7e2049ba6f13e5d7c8a01f4e01a",
  observedBy: "server",
  clientDeviceType: "desktop",
  clientOs: "macOS",
  connectionMethod: "direct",
  workspaceStrategy: "worktree",
  variant: "with_files",
  tool: "delegate_task",
  callerProvider: "claudeAgent",
  callerModel: "gpt-5.6-sol",
  callerOrigin: "user",
  callerDepth: 1,
  errorCode: "thread_not_found",
  targetProvider: "codex",
  targetModel: "gpt-5.6-sol",
  targetRuntimeMode: "full-access",
  targetInteractionMode: "default",
  crossProvider: true,
  targetChosen: true,
  mode: "wait",
  waitTimedOut: false,
  batchSize: 2,
  workspace: "worktree",
  delivery: "auto",
  bindToCurrentThread: true,
  status: "completed",
  completionWake: "settled_only",
  durationSeconds: 90,
  createdBy: "user",
  scheduled: false,
  subagent: false,
};
// Every case sends these too, and they must never reach the wire.
const privateProperties = {
  path: "/private/fixture",
  email: "fixture@example.invalid",
  prompt: "PRIVATE-CONTENT",
  error: "PRIVATE-CONTENT",
  authorizationUrl: "https://example.invalid/PRIVATE-CONTENT",
};
// Fields with no Scient normalizer, sent as recorded: what the server records today.
const passThroughCases = [
  {
    name: "client.turn.requested",
    properties: {
      surface: "desktop",
      clientDeviceType: "desktop",
      clientOs: "macOS",
      connectionMethod: "direct",
      messageChars: 57,
      messageWords: 11,
      yelling: 0,
      profanity: 0,
      anguish: 1,
      negation: 2,
      repetition: 0,
      blame: 1,
    },
  },
  {
    name: "feature.used",
    properties: { feature: "overleaf.sync", outcome: "ok", durationMs: 840 },
  },
  {
    name: "provider.turn.completed",
    properties: {
      reportVersion: 2,
      provider: "scient",
      terminalStatus: "completed",
      usageStatus: "complete",
      usageScope: "main_agent",
      usageReported: true,
      hasSubagents: false,
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 40,
      requests: 1,
      failedRequests: 0,
      estimatedCostUsd: 0.0042,
      modelDurationMs: 2300,
      firstTokenMs: 410,
      model: "gpt-5.6-sol",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "new",
      scheduled: false,
      subagent: false,
    },
  },
  // T3's request summary has no Scient normalizer at all.
  {
    name: "provider.request.completed",
    properties: {
      reportVersion: 2,
      provider: "scient",
      requestKind: "user",
      terminalStatus: "completed",
      lifecycleObserved: true,
      model: "gpt-5.6-sol",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "new",
      scheduled: false,
      subagent: false,
      providerTurns: 1,
      continuations: 0,
      steeringRestarts: 0,
      usageStatus: "complete",
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 40,
      requests: 1,
      failedRequests: 0,
      estimatedCostUsd: 0.0042,
      modelDurationMs: 2300,
      nativeChildTurns: 0,
      childUsageStatus: "none",
    },
  },
] as const;

/** One event's input: the fields its normalizer uses, so unrelated sample fields stay out. */
function representativeInput(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const sample: Record<string, unknown> = { ...representativeProperties, ...overrides };
  const used = normalizedKeys(name, sample, context);
  return {
    ...Object.fromEntries(Object.entries(sample).filter(([key]) => used.has(key))),
    ...privateProperties,
  };
}

function fixtureCase(
  label: string,
  name: string,
  properties: Readonly<Record<string, unknown>> | undefined,
) {
  const event = normalizeInheritedEvent(name, properties, context);
  if (event === null) throw new Error(`Missing event normalizer: ${name}`);
  return {
    case: `${name}:${label}`,
    name: event.name,
    privacyLevel: event.privacyLevel,
    consentLevel: event.privacyLevel,
    properties: event.properties,
  };
}

/** Generated wire examples are copied across repositories, never imported at runtime. */
export function buildAnalyticsConformanceFixture() {
  const cases = ANALYTICS_EVENT_NAMES.flatMap((name) => [
    // An owner event without a valid hash is dropped, so it has no fallback case.
    ...(name === "install.owner_observed" ? [] : [fixtureCase("fallbacks", name, undefined)]),
    fixtureCase("representative", name, representativeInput(name)),
  ]);
  for (const name of [
    "feature.viewed",
    "scient.operation.started",
    "scient.operation.completed",
    "scient.operation.failed",
    "scient.operation.cancelled",
  ] as const) {
    cases.push(
      fixtureCase(
        "latex-visual",
        name,
        representativeInput(name, {
          feature: "latex-visual",
          operationKind: "latex-visual-edit",
          trigger: "user",
        }),
      ),
    );
  }
  for (const provider of ["scient", "omp", "muse", "acpRegistry"]) {
    for (const name of [
      "provider.turn.sent",
      "provider.turn.completed",
      "provider.turn.usage",
      "provider.installation.observed",
      "provider.installation.changed",
      "provider.lifecycle.completed",
    ] as const) {
      cases.push(fixtureCase(provider, name, representativeInput(name, { provider })));
    }
  }
  for (const { name, properties } of passThroughCases) {
    cases.push(fixtureCase("passthrough", name, { ...properties, ...privateProperties }));
  }
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    contractRevision: ANALYTICS_CONTRACT_REVISION,
    cases,
  };
}
