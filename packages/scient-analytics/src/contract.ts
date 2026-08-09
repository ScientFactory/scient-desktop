export const ANALYTICS_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_SOURCE = "desktop" as const;

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
  readonly properties: Readonly<Record<string, boolean | string>>;
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
  readonly properties: Readonly<Record<string, boolean | string>>;
}

const PROVIDERS = new Set(["codex", "claudeAgent", "cursor", "grok", "opencode"]);
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
const PROJECT_ADD_METHODS = new Set(["picker", "drag-drop", "recent", "unknown"]);
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
  const withoutPinnedVersion = normalized.replace(/-(?:20\d{6,8})$/u, "");
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
export function normalizeInheritedEvent(
  name: string,
  rawProperties: Readonly<Record<string, unknown>> | undefined,
  context: NormalizationContext,
): NormalizedEvent | null {
  const input = rawProperties ?? {};
  const provider = normalizedProvider(property(input, "provider"));

  switch (name) {
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
    case "provider.turn.completed":
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

const CONSENT_RANK: Readonly<Record<AnalyticsConsent, number>> = {
  off: 0,
  essential: 1,
  product: 2,
  diagnostic: 3,
};

export function consentAllows(consent: AnalyticsConsent, privacyLevel: EventPrivacyLevel): boolean {
  return CONSENT_RANK[consent] >= CONSENT_RANK[privacyLevel];
}
