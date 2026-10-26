import {
  ANALYTICS_CONTRACT_REVISION,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_SCHEMA_VERSION,
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
  // These must be stripped even when every useful property is supplied.
  path: "/private/fixture",
  email: "fixture@example.invalid",
  prompt: "PRIVATE-CONTENT",
  error: "PRIVATE-CONTENT",
  authorizationUrl: "https://example.invalid/PRIVATE-CONTENT",
};

/** Generated wire examples are copied across repositories, never imported at runtime. */
export function buildAnalyticsConformanceFixture() {
  const cases = ANALYTICS_EVENT_NAMES.flatMap((name) =>
    [undefined, representativeProperties].map((properties, index) => {
      const normalized = normalizeInheritedEvent(name, properties, context);
      if (normalized === null) throw new Error(`Missing event normalizer: ${name}`);
      return {
        case: `${name}:${index === 0 ? "fallbacks" : "representative"}`,
        name: normalized.name,
        privacyLevel: normalized.privacyLevel,
        consentLevel: normalized.privacyLevel,
        properties: normalized.properties,
      };
    }),
  );
  for (const name of [
    "feature.viewed",
    "scient.operation.started",
    "scient.operation.completed",
    "scient.operation.failed",
    "scient.operation.cancelled",
  ] as const) {
    const event = normalizeInheritedEvent(
      name,
      {
        ...representativeProperties,
        feature: "latex-visual",
        operationKind: "latex-visual-edit",
        trigger: "user",
      },
      context,
    )!;
    cases.push({
      case: `${name}:latex-visual`,
      name: event.name,
      privacyLevel: event.privacyLevel,
      consentLevel: event.privacyLevel,
      properties: event.properties,
    });
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
      const event = normalizeInheritedEvent(
        name,
        { ...representativeProperties, provider },
        context,
      )!;
      cases.push({
        case: `${name}:${provider}`,
        name: event.name,
        privacyLevel: event.privacyLevel,
        consentLevel: event.privacyLevel,
        properties: event.properties,
      });
    }
  }
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    contractRevision: ANALYTICS_CONTRACT_REVISION,
    cases,
  };
}
