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
          interactionMode: normalizedInteractionMode(property(input, "interactionMode")),
          runtimeMode: normalizedRuntimeMode(property(input, "runtimeMode")),
          attachmentCountBucket: countBucket(property(input, "attachmentCount")),
          hasInput: normalizedBoolean(property(input, "hasInput")),
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
