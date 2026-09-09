export const ANALYTICS_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_SOURCE = "desktop" as const;
import { EVENT_DEFINITIONS } from "./wireContract.ts";

export const ANALYTICS_CONTRACT_REVISION = "4" as const;

export const ANALYTICS_EVENT_NAMES = [
  "app.session.started",
  "app.session.ended",
  "app.health",
  "app.diagnostics",
  "server.boot.heartbeat",
  "provider.session.started",
  "provider.session.recovered",
  "provider.session.stopped",
  "provider.sessions.stopped_all",
  "provider.runtime_mode.changed",
  "provider.turn.sent",
  "provider.turn.completed",
  "provider.turn.failed",
  "provider.turn.stopped",
  "provider.turn.interrupted",
  "provider.request.responded",
  "provider.conversation.rolled_back",
  // Legacy producer event retained in the wire contract for older releases.
  "provider.discovered",
  "provider.installation.observed",
  "provider.installation.changed",
  "provider.readiness.changed",
  "provider.runtime.source.changed",
  "provider.lifecycle.started",
  "provider.lifecycle.completed",
  "provider.lifecycle.failed",
  "provider.lifecycle.cancelled",
  "project.added",
  "project.add.failed",
  "project.opened",
  "project.initialization.completed",
  "project.initialization.failed",
  "thread.created",
  "thread.fork.completed",
  "thread.fork.failed",
  "thread.revert.completed",
  "thread.revert.failed",
  "voice.transcription.started",
  "voice.transcription.completed",
  "voice.transcription.failed",
  "voice.transcription.cancelled",
  "surface.opened",
  "panel.viewed",
  "settings.viewed",
  "usage.viewed",
  "usage.refresh.requested",
  "usage.availability",
  "feature.viewed",
  "provider.turn.usage",
  "setting.changed",
  "scient.operation.started",
  "scient.operation.completed",
  "scient.operation.failed",
  "scient.operation.cancelled",
  "scient.operation.skipped",
] as const;

export const AnalyticsConsent = ["off", "essential", "product", "diagnostic"] as const;
export type AnalyticsConsent = (typeof AnalyticsConsent)[number];
export type EventPrivacyLevel = Exclude<AnalyticsConsent, "off">;
export const AnalyticsPriority = ["critical", "core", "summary"] as const;
export type AnalyticsPriority = (typeof AnalyticsPriority)[number];

export interface AnalyticsEvent {
  readonly id: string;
  readonly name: string;
  readonly distinct_id: string;
  readonly session_id: string;
  readonly occurred_at: string;
  readonly privacy_level: EventPrivacyLevel;
  readonly consent_level: EventPrivacyLevel;
  readonly properties: Readonly<Record<string, boolean | string | number>>;
}

export interface AnalyticsBatch {
  readonly schema_version: typeof ANALYTICS_SCHEMA_VERSION;
  readonly source: typeof ANALYTICS_SOURCE;
  readonly events: ReadonlyArray<AnalyticsEvent>;
}

export interface NormalizationContext {
  readonly appVersion: string;
  readonly buildChannel: "stable" | "beta" | "nightly" | "development" | "unknown";
}

export interface NormalizedEvent {
  readonly name: string;
  readonly privacyLevel: EventPrivacyLevel;
  readonly priority: AnalyticsPriority;
  readonly properties: Readonly<Record<string, boolean | string | number>>;
}

const PROVIDERS = new Set([
  "codex",
  "claudeAgent",
  "antigravity",
  "droid",
  "cursor",
  "grok",
  "opencode",
  "pi",
]);
const RUNTIME_SOURCES = new Set(["custom", "system", "scient_managed", "missing", "unknown"]);
const LIFECYCLE_ACTIONS = new Set([
  "install",
  "update",
  "repair",
  "remove",
  "sign-in",
  "sign-out",
  "source-switch",
]);
const LIFECYCLE_STAGES = new Set([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
  "starting",
  "waiting_for_browser",
  "waiting_for_device_code",
  "queued",
  "running",
  "unknown",
]);
const FAILURE_CLASSES = new Set([
  "configuration",
  "authentication",
  "connection",
  "permission",
  "provider",
  "timeout",
  "filesystem",
  "checkpoint",
  "validation",
  "unavailable",
  "incompatible-version",
  "missing-dependency",
  "resource-exhaustion",
  "process-crash",
  "internal",
  "unknown",
]);
const HEALTH_COMPONENTS = new Set(["desktop", "server", "renderer", "browser", "analytics"]);
const HEALTH_OPERATIONS = new Set([
  "startup",
  "restart",
  "shutdown",
  "termination",
  "migration",
  "update",
]);
const HEALTH_OUTCOMES = new Set(["started", "completed", "failed", "abnormal"]);
const OPERATION_KINDS = new Set([
  "file-preview",
  "pdf-open",
  "pdf-search",
  "pdf-export",
  "source-import",
  "browser",
  "chart-render",
  "math-render",
  "diagram-render",
  "compute-session",
  "compute-run",
  "compute-artifact",
  "latex-build",
  "document-export",
  "source-control",
  "built-in-skill",
  "worktree-provision",
  "thread-fork",
  "thread-revert",
  "turn-retry",
  "turn-steer",
  "queued-follow-up",
  "provider-handoff",
  "other",
]);
const TRIGGERS = new Set(["user", "agent", "automation", "other"]);
const PROVIDER_STATES = new Set(["ready", "warning", "error", "disabled"]);
const DELIVERY_CLASSES = new Set([
  "idle",
  "delivered",
  "network",
  "timeout",
  "rejected",
  "unavailable",
]);
const BUILD_CHANNELS = new Set(["stable", "beta", "nightly", "development", "unknown"]);
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const PLATFORM_VALUES = new Set(["macos", "windows", "linux", "other"]);
const ARCHITECTURE_VALUES = new Set(["arm64", "x64", "other"]);
const SHUTDOWN_CLASSES = new Set(["graceful", "forced", "crash", "unknown"]);
const TURN_FAILURE_CLASSES = new Set([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "interrupted",
  "cancelled",
  "unknown",
]);
const TURN_STOP_CLASSES = new Set(["aborted", "cancelled", "interrupted"]);
const PROJECT_ADD_METHODS = new Set(["picker", "drag-drop", "recent", "unknown"]);
const PROJECT_ADD_FAILURE_STAGES = new Set([
  "validation",
  "inspection",
  "registration",
  "navigation",
  "unknown",
]);
const PROJECT_STATES = new Set(["existing", "new", "unknown"]);
const PROJECT_INITIALIZATION_STATES = new Set([
  "initialized",
  "missing",
  "partial",
  "unavailable",
  "unknown",
]);
const PROJECT_INITIALIZATION_OUTCOMES = new Set([
  "created",
  "already-ready",
  "repaired",
  "unknown",
]);
const PROJECT_FAILURE_CLASSES = new Set([
  "filesystem",
  "permission",
  "validation",
  "unavailable",
  "unknown",
]);
const THREAD_CREATION_SOURCES = new Set(["new", "fork", "import", "unknown"]);
const FORK_WORKSPACE_MODES = new Set(["local", "new-worktree"]);
const FORK_BOUNDARY_CLASSES = new Set(["conversation", "checkpoint"]);
const FORK_FAILURE_CLASSES = new Set([
  "checkpoint-unavailable",
  "git-unavailable",
  "provisioning",
  "validation",
  "unknown",
]);
const REVERT_FAILURE_CLASSES = new Set([
  "checkpoint-unavailable",
  "provider",
  "validation",
  "unknown",
]);
const VOICE_ENGINE_CLASSES = new Set(["local-whisper", "system", "other"]);
const VOICE_LANGUAGE_MODES = new Set(["automatic", "explicit", "unknown"]);
const VOICE_FAILURE_CLASSES = new Set([
  "permission",
  "model-unavailable",
  "audio",
  "engine",
  "cancelled",
  "unknown",
]);
const VOICE_CANCELLATION_STAGES = new Set(["recording", "transcribing", "unknown"]);
const SURFACES = new Set([
  "files",
  "preview",
  "browser",
  "terminal",
  "usage",
  "settings",
  "whats-new",
]);
const MEASURED_SETTINGS = new Set(["direction", "theme", "notifications"]);
const SETTING_VALUES = new Set([
  "automatic",
  "ltr",
  "rtl",
  "system",
  "light",
  "dark",
  "enabled",
  "disabled",
  "unknown",
]);
const KNOWN_MODEL_KEYS = new Set([
  "auto",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "composer-1.5",
  "composer-2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "grok-build",
  "gemini-3.1-pro",
  "gemini-3.7-flash",
  "gemini-3.7-pro",
  "gemini-3.8-flash",
  "openai/gpt-5",
]);

const MODEL_KEY_ALIASES: Readonly<Record<string, string>> = {
  "5.3": "gpt-5.3-codex",
  "5.3-spark": "gpt-5.3-codex-spark",
  "5.4": "gpt-5.4",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-opus-5.0": "claude-opus-5",
  "claude-opus-5-0": "claude-opus-5",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-5.0": "claude-sonnet-5",
  "claude-sonnet-5-0": "claude-sonnet-5",
  composer: "composer-2",
  "gpt-5-codex": "gpt-5.4",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5.3-spark": "gpt-5.3-codex-spark",
  "haiku-4.5": "claude-haiku-4-5",
  opus: "claude-opus-5",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.6-thinking": "claude-opus-4-6",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.8": "claude-opus-4-8",
  "opus-5": "claude-opus-5",
  sonnet: "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.6-thinking": "claude-sonnet-4-6",
  "sonnet-5": "claude-sonnet-5",
};

function property(input: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

function normalizedProvider(value: unknown): string {
  return typeof value === "string" && PROVIDERS.has(value) ? value : "other";
}

function normalizedRuntimeMode(value: unknown): string {
  return typeof value === "string" && RUNTIME_MODES.has(value) ? value : "other";
}

function normalizedBoolean(value: unknown): boolean {
  return value === true;
}

function normalizedEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback = "unknown",
): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

export function countBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value === 0) return "0";
  if (value === 1) return "1";
  if (value <= 3) return "2-3";
  if (value <= 10) return "4-10";
  if (value <= 50) return "11-50";
  return "over-50";
}

function modelFamily(provider: string, model: unknown): string {
  const normalizedModel = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (/^(?:openai\/)?(?:gpt|o[134](?:-|$)|codex)/u.test(normalizedModel)) return "openai";
  if (/^(?:anthropic\/)?claude/u.test(normalizedModel)) return "anthropic";
  if (/^(?:google\/)?gemini/u.test(normalizedModel)) return "google";
  if (/^(?:xai\/)?grok/u.test(normalizedModel)) return "xai";
  if (/^(?:meta\/)?llama|^(?:mistral(?:ai)?\/)?mistral|^(?:qwen\/)?qwen/u.test(normalizedModel)) {
    return "open-source";
  }
  if (normalizedModel) return "other";

  switch (provider) {
    case "codex":
      return "openai";
    case "claudeAgent":
      return "anthropic";
    case "grok":
      return "xai";
    default:
      return provider === "other" ? "unknown" : "other";
  }
}

/**
 * Returns a maintained public model key. User-defined or otherwise unknown
 * model strings deliberately collapse to `other` so analytics cannot leak a
 * private custom-model name.
 */
export function modelKey(model: unknown): string {
  if (typeof model !== "string") return "unknown";
  const normalized = model.trim().toLowerCase();
  if (KNOWN_MODEL_KEYS.has(normalized)) return normalized;
  // Strip only known public namespaces; the result still must be allowlisted.
  const publicSlug = normalized.replace(/^(?:openai|anthropic|google)\//u, "");
  const withoutPinnedVersion = publicSlug.replace(/-(?:20\d{6,8})$/u, "");
  const geminiVariant = withoutPinnedVersion.replace(/-(?:high|medium|low)$/u, "");
  if (geminiVariant.startsWith("gemini-") && KNOWN_MODEL_KEYS.has(geminiVariant))
    return geminiVariant;
  const canonical =
    MODEL_KEY_ALIASES[normalized] ??
    MODEL_KEY_ALIASES[withoutPinnedVersion] ??
    withoutPinnedVersion;
  return KNOWN_MODEL_KEYS.has(canonical) ? canonical : "other";
}

export function durationBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1_000) return "under-1s";
  if (value < 5_000) return "1-5s";
  if (value < 15_000) return "5-15s";
  if (value < 60_000) return "15-60s";
  if (value < 180_000) return "1-3m";
  if (value < 600_000) return "3-10m";
  return "over-10m";
}

function normalizedInteractionMode(value: unknown): string {
  return value === "default" || value === "plan" ? value : "unknown";
}

function normalizedDecision(value: unknown): string {
  switch (value) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved-session";
    case "decline":
      return "denied";
    case "cancel":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * Converts inherited T3 analytics calls into Scient's bounded wire contract.
 * Unknown events are deliberately ignored until they receive a registered
 * Scient event definition.
 */
function normalizeEvent(
  name: string,
  rawProperties: Readonly<Record<string, unknown>> | undefined,
  context: NormalizationContext,
): NormalizedEvent | null {
  const input = rawProperties ?? {};
  const provider = normalizedProvider(property(input, "provider"));

  switch (name) {
    case "app.health":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          component: normalizedEnum(property(input, "component"), HEALTH_COMPONENTS),
          operation: normalizedEnum(property(input, "operation"), HEALTH_OPERATIONS),
          outcome: normalizedEnum(property(input, "outcome"), HEALTH_OUTCOMES),
          failureClass: normalizedEnum(property(input, "failureClass"), FAILURE_CLASSES),
          durationBucket: durationBucket(property(input, "durationMs")),
        },
      };
    case "app.diagnostics":
      return {
        name,
        privacyLevel: "diagnostic",
        priority: "summary",
        properties: {
          queuedCountBucket: countBucket(property(input, "queuedCount")),
          droppedCountBucket: countBucket(property(input, "droppedCount")),
          retryCountBucket: countBucket(property(input, "retryCount")),
          deliveryClass: normalizedEnum(property(input, "deliveryClass"), DELIVERY_CLASSES),
        },
      };
    case "provider.discovered":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          provider,
          runtimeSource: normalizedEnum(property(input, "source"), RUNTIME_SOURCES),
          state: normalizedEnum(property(input, "state"), PROVIDER_STATES),
        },
      };
    case "provider.installation.observed":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          provider,
          installed: normalizedBoolean(property(input, "installed")),
        },
      };
    case "provider.installation.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          fromInstalled: normalizedBoolean(property(input, "fromInstalled")),
          toInstalled: normalizedBoolean(property(input, "toInstalled")),
        },
      };
    case "provider.readiness.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          from: normalizedEnum(property(input, "from"), PROVIDER_STATES),
          to: normalizedEnum(property(input, "to"), PROVIDER_STATES),
        },
      };
    case "provider.runtime.source.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          from: normalizedEnum(property(input, "from"), RUNTIME_SOURCES),
          to: normalizedEnum(property(input, "to"), RUNTIME_SOURCES),
        },
      };
    case "provider.lifecycle.started":
    case "provider.lifecycle.completed":
    case "provider.lifecycle.failed":
    case "provider.lifecycle.cancelled":
      return {
        name,
        privacyLevel: name === "provider.lifecycle.failed" ? "essential" : "product",
        priority: name === "provider.lifecycle.failed" ? "critical" : "core",
        properties: {
          provider,
          action: normalizedEnum(property(input, "action"), LIFECYCLE_ACTIONS),
          runtimeSource: normalizedEnum(property(input, "source"), RUNTIME_SOURCES),
          stage: normalizedEnum(property(input, "stage"), LIFECYCLE_STAGES),
          failureClass: normalizedEnum(property(input, "failureClass"), FAILURE_CLASSES),
          durationBucket: durationBucket(property(input, "durationMs")),
        },
      };
    case "scient.operation.started":
    case "scient.operation.completed":
    case "scient.operation.failed":
    case "scient.operation.cancelled":
    case "scient.operation.skipped":
      return {
        name,
        privacyLevel: name === "scient.operation.failed" ? "essential" : "product",
        priority: name === "scient.operation.failed" ? "critical" : "core",
        properties: {
          operationKind: normalizedEnum(property(input, "operationKind"), OPERATION_KINDS, "other"),
          trigger: normalizedEnum(property(input, "trigger"), TRIGGERS, "other"),
          durationBucket: durationBucket(property(input, "durationMs")),
          failureClass: normalizedEnum(property(input, "failureClass"), FAILURE_CLASSES),
          reviewRequired: normalizedBoolean(property(input, "reviewRequired")),
        },
      };
    case "app.session.started":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          appVersion: context.appVersion,
          buildChannel: context.buildChannel,
          platform: normalizedEnum(property(input, "platform"), PLATFORM_VALUES, "other"),
          architecture: normalizedEnum(
            property(input, "architecture"),
            ARCHITECTURE_VALUES,
            "other",
          ),
        },
      };
    case "app.session.ended":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          durationBucket: durationBucket(property(input, "durationMs")),
          shutdownClass: normalizedEnum(property(input, "shutdownClass"), SHUTDOWN_CLASSES),
        },
      };
    case "server.boot.heartbeat":
      return {
        name,
        privacyLevel: "essential",
        priority: "summary",
        properties: {
          appVersion: context.appVersion,
          buildChannel: context.buildChannel,
        },
      };
    case "provider.session.started":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          runtimeMode: normalizedRuntimeMode(property(input, "runtimeMode")),
          hasResumeCursor: normalizedBoolean(property(input, "hasResumeCursor")),
          hasCwd: normalizedBoolean(property(input, "hasCwd")),
          hasModel: normalizedBoolean(property(input, "hasModel")),
        },
      };
    case "provider.session.recovered":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          strategy:
            property(input, "strategy") === "adopt-existing" ? "adopt-existing" : "resume-thread",
          hasResumeCursor: normalizedBoolean(property(input, "hasResumeCursor")),
        },
      };
    case "provider.session.stopped":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: { provider },
      };
    case "provider.sessions.stopped_all":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          sessionCountBucket: countBucket(property(input, "sessionCount")),
          shutdownClass: "unknown",
        },
      };
    case "provider.runtime_mode.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          from: normalizedRuntimeMode(property(input, "from")),
          to: normalizedRuntimeMode(property(input, "to")),
        },
      };
    case "provider.turn.sent":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          modelFamily: modelFamily(provider, property(input, "model")),
          modelKey: modelKey(property(input, "model")),
          interactionMode: normalizedInteractionMode(property(input, "interactionMode")),
          runtimeMode: normalizedRuntimeMode(property(input, "runtimeMode")),
          attachmentCountBucket: countBucket(property(input, "attachmentCount")),
          hasInput: normalizedBoolean(property(input, "hasInput")),
        },
      };
    case "usage.refresh.requested": {
      return { name, privacyLevel: "product", priority: "core", properties: {} };
    }
    case "panel.viewed":
    case "settings.viewed":
    case "usage.viewed":
    case "usage.availability":
    case "feature.viewed": {
      const properties: Record<string, string> = {};
      for (const [key, rule] of Object.entries(EVENT_DEFINITIONS[name].properties)) {
        properties[key] = normalizedEnum(property(input, key), new Set(rule.values), "other");
      }
      return { name, privacyLevel: "product", priority: "core", properties };
    }
    case "provider.turn.usage": {
      const properties: Record<string, string | boolean | number> = {
        provider,
        modelKey:
          property(input, "mixedModels") === true ? "other" : modelKey(property(input, "model")),
        terminalStatus:
          normalizedEnum(
            property(input, "terminalStatus"),
            new Set(["cancelled", "interrupted"]),
            "other",
          ) !== "other"
            ? "stopped"
            : normalizedEnum(
                property(input, "terminalStatus"),
                new Set(["completed", "failed", "stopped"]),
                "other",
              ),
        usageStatus: normalizedEnum(
          property(input, "usageStatus"),
          new Set(["complete", "partial", "unavailable"]),
          "unavailable",
        ),
        usageScope: "main_agent",
      };
      if (typeof property(input, "hasSubagents") === "boolean")
        properties.hasSubagents = property(input, "hasSubagents") as boolean;
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheCreationTokens",
        "reasoningTokens",
      ]) {
        const value = property(input, key);
        if (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 1_000_000_000
        )
          properties[key] = value;
      }
      for (const [subset, total] of [
        ["cachedInputTokens", "inputTokens"],
        ["cacheCreationTokens", "inputTokens"],
        ["reasoningTokens", "outputTokens"],
      ] as const) {
        if (
          typeof properties[subset] === "number" &&
          typeof properties[total] === "number" &&
          properties[subset] > properties[total]
        )
          delete properties[subset];
      }
      if (
        properties.usageStatus === "complete" &&
        (properties.inputTokens === undefined || properties.outputTokens === undefined)
      )
        properties.usageStatus = "partial";
      const hasCounts = [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheCreationTokens",
        "reasoningTokens",
      ].some((key) => properties[key] !== undefined);
      if (!hasCounts) properties.usageStatus = "unavailable";
      else if (properties.usageStatus === "unavailable") properties.usageStatus = "partial";
      return { name, privacyLevel: "product", priority: "core", properties };
    }
    case "provider.turn.completed":
      // Keep outcomes owned by the semantic observer; reuse upstream's
      // instance-aware terminal/model association only for product usage.
      if (property(input, "terminalStatus") !== undefined)
        return normalizeEvent("provider.turn.usage", input, context);
      return {
        name,
        privacyLevel: "product",
        priority: "critical",
        properties: {
          provider,
          modelKey: modelKey(property(input, "model")),
          durationBucket: durationBucket(property(input, "durationMs")),
          usedTools: normalizedBoolean(property(input, "usedTools")),
          hasAttachment: normalizedBoolean(property(input, "hasAttachment")),
        },
      };
    case "provider.turn.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          provider,
          modelKey: modelKey(property(input, "model")),
          failureClass: normalizedEnum(property(input, "failureClass"), TURN_FAILURE_CLASSES),
          durationBucket: durationBucket(property(input, "durationMs")),
        },
      };
    case "provider.turn.stopped":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          modelKey: modelKey(property(input, "model")),
          durationBucket: durationBucket(property(input, "durationMs")),
          stopClass: normalizedEnum(property(input, "stopClass"), TURN_STOP_CLASSES),
        },
      };
    case "provider.turn.interrupted":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: { provider, initiator: "user" },
      };
    case "provider.request.responded":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          requestKind: "approval",
          decision: normalizedDecision(property(input, "decision")),
        },
      };
    case "provider.conversation.rolled_back":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          turnCountBucket: countBucket(property(input, "turns")),
        },
      };
    case "project.added":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          method: normalizedEnum(property(input, "method"), PROJECT_ADD_METHODS),
        },
      };
    case "project.add.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          stage: normalizedEnum(property(input, "stage"), PROJECT_ADD_FAILURE_STAGES),
        },
      };
    case "project.opened":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          projectState: normalizedEnum(property(input, "projectState"), PROJECT_STATES),
          initializationState: normalizedEnum(
            property(input, "initializationState"),
            PROJECT_INITIALIZATION_STATES,
          ),
        },
      };
    case "project.initialization.completed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          outcome: normalizedEnum(property(input, "outcome"), PROJECT_INITIALIZATION_OUTCOMES),
          filesCreatedBucket: countBucket(property(input, "filesCreated")),
        },
      };
    case "project.initialization.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          failureClass: normalizedEnum(property(input, "failureClass"), PROJECT_FAILURE_CLASSES),
        },
      };
    case "thread.created":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          creationSource: normalizedEnum(
            property(input, "creationSource"),
            THREAD_CREATION_SOURCES,
          ),
        },
      };
    case "thread.fork.completed":
      return {
        name,
        privacyLevel: "product",
        priority: "critical",
        properties: {
          workspaceMode: normalizedEnum(property(input, "workspaceMode"), FORK_WORKSPACE_MODES),
          boundaryClass: normalizedEnum(property(input, "boundaryClass"), FORK_BOUNDARY_CLASSES),
          refork: normalizedBoolean(property(input, "refork")),
        },
      };
    case "thread.fork.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          workspaceMode: normalizedEnum(property(input, "workspaceMode"), FORK_WORKSPACE_MODES),
          failureClass: normalizedEnum(property(input, "failureClass"), FORK_FAILURE_CLASSES),
        },
      };
    case "thread.revert.completed":
      return {
        name,
        privacyLevel: "product",
        priority: "critical",
        properties: { boundaryClass: "checkpoint" },
      };
    case "thread.revert.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          failureClass: normalizedEnum(property(input, "failureClass"), REVERT_FAILURE_CLASSES),
        },
      };
    case "voice.transcription.started":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          engineClass: normalizedEnum(
            property(input, "engineClass"),
            VOICE_ENGINE_CLASSES,
            "other",
          ),
          languageMode: normalizedEnum(property(input, "languageMode"), VOICE_LANGUAGE_MODES),
        },
      };
    case "voice.transcription.completed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          engineClass: normalizedEnum(
            property(input, "engineClass"),
            VOICE_ENGINE_CLASSES,
            "other",
          ),
          durationBucket: durationBucket(property(input, "durationMs")),
          audioDurationBucket: durationBucket(property(input, "audioDurationMs")),
        },
      };
    case "voice.transcription.failed":
      return {
        name,
        privacyLevel: "essential",
        priority: "critical",
        properties: {
          engineClass: normalizedEnum(
            property(input, "engineClass"),
            VOICE_ENGINE_CLASSES,
            "other",
          ),
          failureClass: normalizedEnum(property(input, "failureClass"), VOICE_FAILURE_CLASSES),
        },
      };
    case "voice.transcription.cancelled":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          stage: normalizedEnum(property(input, "stage"), VOICE_CANCELLATION_STAGES),
        },
      };
    case "surface.opened":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          surface: normalizedEnum(property(input, "surface"), SURFACES),
        },
      };
    case "setting.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          setting: normalizedEnum(property(input, "setting"), MEASURED_SETTINGS),
          value: normalizedEnum(property(input, "value"), SETTING_VALUES),
        },
      };
    default:
      return null;
  }
}

/** Public release coordinates only; custom build labels must never become identity hints. */
export function analyticsAppVersion(value: string): string {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|nightly|rc|dev)(?:\.\d{1,14}){0,3})?$/u.test(value)
    ? value
    : "unknown";
}

export function normalizeInheritedEvent(
  name: string,
  rawProperties: Readonly<Record<string, unknown>> | undefined,
  context: NormalizationContext,
): NormalizedEvent | null {
  const normalized = normalizeEvent(name, rawProperties, context);
  return normalized === null
    ? null
    : {
        ...normalized,
        properties: {
          ...normalized.properties,
          appVersion: analyticsAppVersion(context.appVersion),
          buildChannel: normalizedEnum(context.buildChannel, BUILD_CHANNELS),
          contractRevision: ANALYTICS_CONTRACT_REVISION,
        },
      };
}

const CONSENT_RANK: Readonly<Record<AnalyticsConsent, number>> = {
  off: 0,
  essential: 1,
  product: 2,
  diagnostic: 3,
};

export function consentAllows(consent: AnalyticsConsent, privacyLevel: EventPrivacyLevel): boolean {
  return CONSENT_RANK[consent] >= CONSENT_RANK[privacyLevel];
}
