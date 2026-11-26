export const ANALYTICS_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_SOURCE = "desktop" as const;
import { analyticsFailureCode } from "./failureCodes.ts";
import {
  ANALYTICS_CONTRACT_REVISION,
  EVENT_NAME_PATTERN,
  isAllowedAccountEmail,
  isContentKey,
  isPrivateLooking,
  isWirePrimitive,
  MAX_ARRAY_PROPERTY_ITEMS,
  MAX_EVENT_PROPERTIES,
  MAX_EVENT_PROPERTIES_BYTES,
  PROPERTY_KEY_PATTERN,
  type WireValue,
} from "./wireContract.ts";
export { ANALYTICS_CONTRACT_REVISION } from "./wireContract.ts";

/** Events with a Scient normalizer. Any other event is still recorded, as in T3. */
export const ANALYTICS_EVENT_NAMES = [
  "app.session.started",
  "app.session.ended",
  "app.health",
  "app.diagnostics",
  "app.update.outcome",
  "app.update.summary",
  "app.startup.timing",
  "server.boot.heartbeat",
  "install.owner_observed",
  "install.account_observed",
  "install.profile_observed",
  "client.turn.requested",
  "client.thread.started",
  "feature.used",
  "mcp.tool.invoked",
  "mcp.delegated_task.finished",
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
  "provider.readiness.observed",
  "provider.readiness.changed",
  "provider.runtime.source.changed",
  "provider.lifecycle.started",
  "provider.lifecycle.completed",
  "provider.lifecycle.failed",
  "provider.lifecycle.cancelled",
  "provider.runtime.first_pick",
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
  "voice.recording.failed",
  "voice.recording.cancelled",
  "surface.opened",
  "panel.viewed",
  "settings.viewed",
  "usage.viewed",
  "usage.refresh.requested",
  "usage.availability",
  "feature.viewed",
  "latex.visual.opened",
  "latex.visual.source-fallback",
  "provider.turn.usage",
  "setting.changed",
  "scient.operation.started",
  "scient.operation.completed",
  "scient.operation.failed",
  "scient.operation.cancelled",
  "scient.operation.skipped",
  "provider.commands.observed",
] as const;

/**
 * Who a failure belongs to: Scient itself, the code or document being run, a request's input,
 * the computer's environment, an outside service, or a cancellation. `unknown` keeps doubt.
 */
const FAILURE_OWNERS = [
  "scient",
  "code",
  "input",
  "environment",
  "external",
  "cancelled",
  "unknown",
] as const;
export type FailureOwner = (typeof FAILURE_OWNERS)[number];

/** The closed reasons a failure is filed under; an error's own name is never one of them. */
const FAILURE_CATEGORIES = [
  // Compute runs
  "code-error",
  "syntax",
  "assertion",
  "data",
  "filesystem",
  "permission",
  "network",
  "missing-dependency",
  "out-of-memory",
  "interrupted",
  "exited",
  "runtime-reported",
  "dispatch",
  "runtime-start",
  "app-restart",
  "runtime-connection",
  "runtime-exited",
  "kernel-exited",
  "kernel-connection",
  "protocol-error",
  "missing-capability",
  "admission-timeout",
  "source-conflict",
  // Run file
  "nonzero-exit",
  "not-started",
  "failed-after-exit",
  "runtime-missing",
  "source-changed",
  // PDF export
  "project-required",
  "project-changed",
  "invalid-source-path",
  "invalid-output-path",
  "source-not-found",
  "renderer-unavailable",
  "render-failed",
  "publication-failed",
  "output-write-failed",
  "partial-publication",
  "unsupported-format",
  "too-large",
  "unsaved-changes",
  "prepare-failed",
  "delivery-failed",
  // LaTeX builds
  "compile_error",
  "missing_package",
  "missing_engine",
  "no_output",
  "timeout",
  "sources_changed",
  "publish",
  "workspace",
  "internal",
  // Figure and table capture
  "scan-timeout",
  "scan-entry-limit",
  "scan-depth-limit",
  "scan-unreadable",
  "watch-unavailable",
  "watch-overflow",
  "watch-unverifiable",
  "observation-unavailable",
  "output-limit",
  "image-limit",
  "unsafe-image",
  "invalid-image",
  "image-changed",
  "missing-resource",
  "resource-mismatch",
  "persistence-failed",
  "artifact-collection-failed",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** The kinds of program an agent runs in its own terminal, read locally from the command. */
const COMMAND_CATEGORIES = [
  "python",
  "python-package-install",
  "jupyter",
  "r",
  "julia",
  "matlab",
  "octave",
  "stata",
  "sas",
  "sql",
  "latex",
  "document-convert",
  "quarto",
  "workflow",
  "hpc",
  "remote",
  "container",
  "compile",
  "javascript",
  "system-package-install",
  "version-control",
  "download",
  "file-inspection",
  "file-management",
  "shell-other",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

const COMPUTE_ACTORS = new Set(["user", "agent"]);
const COMPUTE_ENTRIES = new Set(["console", "file", "selection", "cell", "run-file"]);
const COMPUTE_RUNTIME_SOURCES = new Set([
  "managed",
  "configured",
  "project",
  "path",
  "conventional",
]);

function attributionProperties(input: Readonly<Record<string, unknown>>) {
  return {
    ...(property(input, "failureOwner") === undefined
      ? {}
      : { failureOwner: closedCategory(property(input, "failureOwner"), FAILURE_OWNERS) }),
    ...(property(input, "failureCategory") === undefined
      ? {}
      : {
          failureCategory: closedCategory(property(input, "failureCategory"), FAILURE_CATEGORIES),
        }),
  };
}

export type EventPrivacyLevel = "essential" | "product" | "diagnostic";
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
  readonly properties: Readonly<Record<string, WireValue>>;
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
  readonly properties: Readonly<Record<string, WireValue>>;
}

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
const LIFECYCLE_TRIGGERS = new Set(["user", "background"]);
const DOWNLOAD_SOURCES = new Set(["primary", "fallback"]);
const DOWNLOAD_SOURCE_KINDS = new Set(["scient_mirror", "github", "vendor"]);
const DOWNLOAD_VARIANTS = new Set(["compressed", "raw"]);
const DOWNLOAD_NETWORK_KINDS = new Set([
  "dns",
  "refused",
  "reset",
  "unreachable",
  "connect_timeout",
  "stalled",
  "cut_off",
  "other",
]);
const LIFECYCLE_FAILED_CHECKS = new Set([
  "smoke",
  "reserve",
  "stop_sessions",
  "rpc_start",
  "protocol",
  "version",
  "get_state",
  "qualification",
  "activation",
  "rollback",
  "refresh",
]);
const SIGN_IN_FAILURE_REASONS = new Set([
  "start_failed",
  "no_signin_page",
  "invalid_response",
  "timeout",
  "provider_failed",
  "provider_exited",
  "verification",
  "post_signin_setup",
  "flow_stopped",
  "unknown",
]);
const SIGN_IN_PAGES = new Set(["primary", "manual_fallback", "none"]);
const TOOL_SERVER_OWNERS = new Set(["scient", "connector", "user", "unknown"]);
const ENDPOINT_SCHEMES = new Set(["http", "https"]);
const ENDPOINT_SOURCES = new Set(["claude-settings", "environment"]);
// A DNS name, IPv4 address or bracketed IPv6 address: never a path, link or credential.
const ENDPOINT_HOST_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]{2,45}\]$/;

/** The custom API endpoint an account sends its requests to, split so no field is a link. */
function accountEndpointProperties(
  input: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  // Read every field first: an unread key would pass through unvalidated.
  const rawHost = property(input, "endpointHost");
  // A fully qualified name's root dot names the same host.
  const host = typeof rawHost === "string" ? rawHost.replace(/\.$/u, "") : rawHost;
  const scheme = property(input, "endpointScheme");
  const source = property(input, "endpointSource");
  const port = property(input, "endpointPort");
  if (typeof host !== "string" || !ENDPOINT_HOST_PATTERN.test(host)) return {};
  return {
    endpointHost: host.toLowerCase(),
    ...(typeof scheme === "string" && ENDPOINT_SCHEMES.has(scheme)
      ? { endpointScheme: scheme }
      : {}),
    ...(typeof source === "string" && ENDPOINT_SOURCES.has(source)
      ? { endpointSource: source }
      : {}),
    ...(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535
      ? { endpointPort: port }
      : {}),
  };
}
const FIRST_PICK_STATES = new Set(["ready", "in_progress", "failed", "not_started"]);
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
  // Managed provider runtime installs, updates and repairs
  "network",
  "http_4xx",
  "http_5xx",
  "checksum",
  "size_mismatch",
  "certificate",
  "disk_full",
  "extract",
  "cancelled",
  "busy",
  "stalled",
  "other",
  // LaTeX builds
  "compile_error",
  "missing_package",
  "missing_engine",
  "no_output",
  "sources_changed",
  "publish",
  "workspace",
]);
const PROCESS_EXIT_REASONS = new Set(["crashed", "oom", "killed", "abnormal-exit"]);
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
// Desktop app updates: each step's outcomes, and why a step failed.
const UPDATE_STEP_OUTCOMES: Readonly<Record<string, ReadonlyArray<string>>> = {
  check: ["started", "completed", "failed"],
  download: ["started", "completed", "failed"],
  install: ["handoff-attempted", "failed"],
  apply: ["completed", "not-applied", "superseded"],
};
const UPDATE_FAILURE_CLASSES = [
  "network",
  "timeout",
  "certificate",
  "http_4xx",
  "http_5xx",
  "feed",
  "checksum",
  "signature",
  "disk_full",
  "permission",
  "configuration",
  "cancelled",
  "internal",
  "unknown",
];
const UPDATE_STATUSES = [
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
];
const UPDATE_DISABLED_CLASSES = [
  "policy",
  "channel-policy",
  "safety",
  "no-feed",
  "development",
  "environment",
  "linux-package",
  "other",
];
const UPDATE_ATTEMPT_REF_PATTERN = /^[0-9a-f]{16}$/u;
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
  "latex-visual-edit",
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
const READINESS_PROVIDERS = [
  "acpRegistry",
  "antigravity",
  "claudeAgent",
  "codex",
  "cursor",
  "droid",
  "fx",
  "grok",
  "kiro",
  "muse",
  "omp",
  "opencode",
  "pi",
  "scient",
] as const;
const STATUS_CHECK_FAILURES = new Set([
  "version_timeout",
  "version_failed",
  "start_failed",
  "busy",
  "command_timeout",
  "command_failed",
  "exit",
  "parse",
  "not_authenticated",
  "other",
]);
const VISUAL_OPEN_FAILURES = {
  unavailable: ["root-unresolved", "source-truncated", "source-read-only"],
  "open-error": ["root-resolution", "source-read", "source-assembly", "projection", "recovery"],
} as const;
const DELIVERY_CLASSES = new Set([
  "idle",
  "delivered",
  "network",
  "timeout",
  "rejected",
  "unavailable",
]);
const BUILD_CHANNELS = new Set(["stable", "beta", "nightly", "development", "unknown"]);
const PLATFORM_VALUES = new Set(["macos", "windows", "linux", "other"]);
const ARCHITECTURE_VALUES = new Set(["arm64", "x64", "other"]);
const SHUTDOWN_CLASSES = new Set(["graceful", "forced", "crash", "unknown"]);
const TURN_FAILURE_CLASSES = new Set([
  "usage_limit",
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
const VOICE_ENGINE_CLASSES = new Set(["local-whisper", "chatgpt", "system", "other"]);
const VOICE_LANGUAGE_MODES = new Set(["automatic", "explicit", "unknown"]);
const VOICE_FAILURE_CLASSES = new Set([
  "permission",
  "model-unavailable",
  "audio",
  "engine",
  "delivery",
  "cancelled",
  "unknown",
]);
const VOICE_CANCELLATION_STAGES = new Set([
  "recording",
  "preparing",
  "transcribing",
  "correcting",
  "unknown",
]);

function countOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;
}

function closedCategory(value: unknown, allowed: ReadonlyArray<string>): string {
  return typeof value === "string" && allowed.includes(value) ? value : "unknown";
}

function captureProperties(input: Readonly<Record<string, unknown>>, terminal: boolean) {
  if (property(input, "captureSchemaVersion") !== 2) return {};
  const identity = {
    captureSchemaVersion: 2,
    captureSource: closedCategory(property(input, "captureSource"), ["interactive", "run-file"]),
  };
  // Read terminal inputs on starts too, so inherited passthrough cannot send raw counts.
  const outcome = {
    captureOutcome: closedCategory(property(input, "captureOutcome"), [
      "retained",
      "partial",
      "none",
      "failed",
      "unobserved",
    ]),
    captureCoverage: closedCategory(property(input, "captureCoverage"), [
      "complete",
      "partial",
      "unavailable",
    ]),
    captureReason: closedCategory(property(input, "captureReason"), [
      "none",
      "scan-timeout",
      "scan-entry-limit",
      "scan-depth-limit",
      "scan-unreadable",
      "watch-unavailable",
      "watch-overflow",
      "watch-unverifiable",
      "observation-unavailable",
      "output-limit",
      "image-limit",
      "unsafe-image",
      "invalid-image",
      "image-changed",
      "missing-resource",
      "resource-mismatch",
      "persistence-failed",
      "artifact-collection-failed",
    ]),
    retainedOutputCountBucket: countBucket(property(input, "retainedOutputCount")),
    rejectedOutputCountBucket: countBucket(property(input, "rejectedOutputCount")),
  };
  return terminal ? { ...identity, ...outcome } : identity;
}

function voiceProperties(input: Readonly<Record<string, unknown>>) {
  if (property(input, "voiceSchemaVersion") !== 2) return {};
  return {
    voiceSchemaVersion: 2,
    ...(property(input, "transcriptionDurationMs") === undefined
      ? {}
      : {
          transcriptionDurationBucket: durationBucket(property(input, "transcriptionDurationMs")),
        }),
    ...(property(input, "correctionDurationMs") === undefined
      ? {}
      : {
          correctionDurationBucket: durationBucket(property(input, "correctionDurationMs")),
        }),
    ...(property(input, "correctionOutcome") === undefined
      ? {}
      : {
          correctionOutcome: closedCategory(property(input, "correctionOutcome"), [
            "disabled",
            "corrected",
            "fallback",
            "bypassed",
            "cancelled",
          ]),
        }),
  };
}
const OWNER_SOURCES = new Set(["connect", "openai", "claude", "device"]);
const OWNER_OBSERVERS = new Set(["server", "client"]);
const OWNER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const CLIENT_SURFACES = new Set(["web", "desktop", "mobile", "cli"]);
const CLIENT_DEVICE_TYPES = new Set(["desktop", "phone", "tablet"]);
const CLIENT_OPERATING_SYSTEMS = new Set([
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "ChromeOS",
  "other",
]);
const CLIENT_CONNECTIONS = new Set(["direct", "ssh", "relay"]);
const TURN_ACTORS = new Set(["user", "agent", "system"]);
const TURN_CREATION_SOURCES = new Set(["web", "mobile", "mcp", "provider", "server"]);
const TOOL_OUTCOMES = new Set(["ok", "error"]);
const TOOL_CALLER_ORIGINS = new Set(["user", "agent", "system", "scheduler"]);
const TOOL_INTERACTION_MODES = new Set(["default", "plan", "unknown"]);
const TOOL_MODES = new Set(["async", "wait"]);
const TOOL_WORKSPACES = new Set(["scratch", "root", "worktree", "existing_worktree"]);
const DELEGATED_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const DELEGATED_TASK_WAKES = new Set(["always", "settled_only"]);
const DELEGATED_TASK_FAILURE_PHASES = ["before_provider", "provider", "unknown"];
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

const MAX_MODEL_KEY_LENGTH = 120;

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

// Keys a normalizer read while normalizing the current event. Normalizers are synchronous, so
// one module-level set is enough; every key they did not read is passed through unchanged.
let readKeys: Set<string> | undefined;

function property(input: Readonly<Record<string, unknown>>, key: string): unknown {
  readKeys?.add(key);
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

// These events have a closed payload even though the wire supports inherited properties.
function restrictProperties(input: Readonly<Record<string, unknown>>) {
  for (const key of Object.keys(input)) readKeys?.add(key);
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function normalizedProvider(value: unknown): string {
  return isIdentifier(value) ? value : "other";
}

function shortLabel(value: unknown, maxLength = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
  return label === "" || isPrivateLooking(label) ? undefined : label;
}

function normalizedRuntimeMode(value: unknown): string {
  return isIdentifier(value) ? value : "other";
}

function normalizedBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * A value code passes keeps its name, even one the set does not list yet, such as a new upstream
 * failure class. Only missing or free-form values fall back. The set documents the usual values.
 */
function normalizedEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback = "unknown",
): string {
  return typeof value === "string" && (allowed.has(value) || IDENTIFIER_PATTERN.test(value))
    ? value
    : fallback;
}

function normalizedIdentifier(value: unknown, fallback: string): string {
  return isIdentifier(value) ? value : fallback;
}

/** Copies an optional field only when it is a valid value; unknown values stay absent. */
function optionalProperties(
  input: Readonly<Record<string, unknown>>,
  rules: Readonly<Record<string, "count" | "boolean" | "identifier" | ReadonlySet<string>>>,
): Record<string, string | boolean | number> {
  const properties: Record<string, string | boolean | number> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = property(input, key);
    if (rule === "boolean" && typeof value === "boolean") properties[key] = value;
    else if (
      rule === "count" &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 1_000_000_000
    )
      properties[key] = value;
    else if (rule === "identifier" && normalizedIdentifier(value, "") !== "")
      properties[key] = value as string;
    else if (rule instanceof Set && normalizedEnum(value, rule, "") !== "")
      properties[key] = value as string;
  }
  return properties;
}

/** Which run a turn outcome belongs to (a one-way hash), and the agent build that ran it. */
function turnRunProperties(input: Readonly<Record<string, unknown>>): {
  runRef?: string;
  providerVersion?: string;
} {
  const runRef = property(input, "runRef");
  const version = property(input, "providerVersion");
  return {
    ...(typeof runRef === "string" && /^[0-9a-f]{16}$/u.test(runRef) ? { runRef } : {}),
    ...(typeof version === "string" && analyticsAppVersion(version) !== "unknown"
      ? { providerVersion: version }
      : {}),
  };
}

/** A failure code, kept only when it is one of `provider`'s known categories. */
function failureCodeProperty(
  provider: string,
  input: Readonly<Record<string, unknown>>,
): { failureCode?: string } {
  const code = analyticsFailureCode(provider, property(input, "failureCode"));
  return code === undefined ? {} : { failureCode: code };
}

/** A provider's HTTP status, kept only as a real status code. */
function httpStatusProperty(input: Readonly<Record<string, unknown>>): { httpStatus?: number } {
  const value = property(input, "httpStatus");
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? { httpStatus: value }
    : {};
}

function clientProperties(input: Readonly<Record<string, unknown>>) {
  return {
    surface: normalizedEnum(property(input, "surface"), CLIENT_SURFACES),
    clientDeviceType: normalizedEnum(property(input, "clientDeviceType"), CLIENT_DEVICE_TYPES),
    clientOs: normalizedEnum(property(input, "clientOs"), CLIENT_OPERATING_SYSTEMS),
    connectionMethod: normalizedEnum(property(input, "connectionMethod"), CLIENT_CONNECTIONS),
  };
}

function optionalModelKeys(
  input: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = property(input, key);
      return value === undefined ? [] : [[key, modelKey(value)]];
    }),
  );
}

/** How long an event waited on this computer before it was sent. */
function ageBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 60_000) return "under-1m";
  if (value < 600_000) return "1-10m";
  if (value < 3_600_000) return "10-60m";
  if (value < 21_600_000) return "1-6h";
  if (value < 86_400_000) return "6-24h";
  return "over-1d";
}

function countBucket(value: unknown): string {
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
 * Returns a canonical model key: known aliases and pinned versions fold into one key, and any
 * other model name the agent reports is sent as it is, as in T3. Only a name that looks like a
 * path, link or email address becomes `other`.
 */
export function modelKey(model: unknown): string {
  if (typeof model !== "string") return "unknown";
  const collapsed = model.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return "unknown";
  const normalized = collapsed.toLowerCase().slice(0, MAX_MODEL_KEY_LENGTH).trimEnd();
  // Both spellings: the path pattern matches `Users` and `home` only as written.
  if (isPrivateLooking(collapsed) || isPrivateLooking(normalized)) return "other";
  if (KNOWN_MODEL_KEYS.has(normalized)) return normalized;
  // Strip only known public namespaces.
  const publicSlug = normalized.replace(/^(?:openai|anthropic|google)\//u, "");
  const withoutPinnedVersion = publicSlug.replace(/-(?:20\d{6,8})$/u, "");
  const geminiVariant = withoutPinnedVersion.replace(/-(?:high|medium|low)$/u, "");
  if (geminiVariant.startsWith("gemini-") && KNOWN_MODEL_KEYS.has(geminiVariant))
    return geminiVariant;
  const canonical =
    MODEL_KEY_ALIASES[normalized] ??
    MODEL_KEY_ALIASES[withoutPinnedVersion] ??
    withoutPinnedVersion;
  return canonical === "" ? normalized : canonical;
}

function byteBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value === 0) return "0";
  if (value < 10 * 1024 ** 2) return "under-10mb";
  if (value < 50 * 1024 ** 2) return "10-50mb";
  if (value < 100 * 1024 ** 2) return "50-100mb";
  return "over-100mb";
}

/** Bytes per second, bucketed in megabits per second as connections are quoted. */
function throughputBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  const megabits = (value * 8) / 1_000_000;
  if (megabits < 1) return "under-1mbps";
  if (megabits < 5) return "1-5mbps";
  if (megabits < 20) return "5-20mbps";
  if (megabits < 100) return "20-100mbps";
  return "over-100mbps";
}

function percentBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 25) return "0-24";
  if (value < 50) return "25-49";
  if (value < 75) return "50-74";
  return "75-100";
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

/** How long an update stage or offer has lasted: minutes while transferring, days while waiting. */
function updateAgeBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 60_000) return "under-1m";
  if (value < 600_000) return "1-10m";
  if (value < 3_600_000) return "10-60m";
  if (value < 21_600_000) return "1-6h";
  if (value < 86_400_000) return "6-24h";
  if (value < 3 * 86_400_000) return "1-3d";
  if (value < 7 * 86_400_000) return "3-7d";
  return "over-7d";
}

/** Copies a field only when it is one of `allowed`; any other value stays absent. */
function optionalClosed(
  input: Readonly<Record<string, unknown>>,
  key: string,
  allowed: ReadonlyArray<string>,
): Record<string, string> {
  const value = property(input, key);
  return typeof value === "string" && allowed.includes(value) ? { [key]: value } : {};
}

/** Marks every field read, so an event sends only what its normalizer sets. */
function closedEvent(input: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(input)) property(input, key);
}

function updateOutcomeProperties(input: Readonly<Record<string, unknown>>) {
  closedEvent(input);
  const step = closedCategory(property(input, "step"), Object.keys(UPDATE_STEP_OUTCOMES));
  const outcome = closedCategory(property(input, "outcome"), UPDATE_STEP_OUTCOMES[step] ?? []);
  const failureClass = closedCategory(property(input, "failureClass"), UPDATE_FAILURE_CLASSES);
  const trigger = property(input, "trigger");
  const targetVersion = property(input, "targetVersion");
  const attemptRef = property(input, "attemptRef");
  const durationMs = property(input, "durationMs");
  return {
    step,
    outcome,
    ...(outcome === "failed" ? { failureClass } : {}),
    ...(step !== "apply" && (trigger === "user" || trigger === "background") ? { trigger } : {}),
    ...(typeof targetVersion === "string" && analyticsAppVersion(targetVersion) !== "unknown"
      ? { targetVersion }
      : {}),
    ...optionalClosed(input, "sourceKind", ["github", "scient_mirror", "administrator"]),
    ...optionalClosed(input, "packageKind", ["zip", "nsis", "appimage", "deb"]),
    ...(typeof attemptRef === "string" && UPDATE_ATTEMPT_REF_PATTERN.test(attemptRef)
      ? { attemptRef }
      : {}),
    ...(durationMs === undefined ? {} : { durationBucket: updateAgeBucket(durationMs) }),
  };
}

function updateSummaryProperties(input: Readonly<Record<string, unknown>>) {
  closedEvent(input);
  const status = closedCategory(property(input, "status"), UPDATE_STATUSES);
  const lastCheckAgeMs = property(input, "lastCheckAgeMs");
  return {
    reason: closedCategory(property(input, "reason"), ["launch", "change", "daily"]),
    status,
    channel: closedCategory(property(input, "channel"), ["latest", "beta", "nightly"]),
    behind: closedCategory(property(input, "behind"), ["yes", "no", "unknown"]),
    stageAgeBucket: updateAgeBucket(property(input, "stageAgeMs")),
    lastCheckAgeBucket: lastCheckAgeMs === undefined ? "never" : updateAgeBucket(lastCheckAgeMs),
    droppedFactsBucket: countBucket(property(input, "droppedFactCount") ?? 0),
    ...(status === "error"
      ? {
          errorContext: closedCategory(property(input, "errorContext"), [
            "check",
            "download",
            "install",
          ]),
        }
      : {}),
    ...(status === "downloading"
      ? {
          progressBucket: percentBucket(property(input, "downloadPercent")),
          sinceProgressBucket: updateAgeBucket(property(input, "sinceProgressMs")),
        }
      : {}),
    ...(status === "downloaded"
      ? { readyAgeBucket: updateAgeBucket(property(input, "readyAgeMs")) }
      : {}),
    ...(status === "disabled"
      ? {
          disabledClass: closedCategory(property(input, "disabledClass"), UPDATE_DISABLED_CLASSES),
        }
      : {}),
  };
}

/**
 * How long a launch took to reach a stage. Steps roughly double, so each one is equally coarse
 * relative to the time: a warm launch on a fast computer lands under 2 s, while a first open the
 * operating system scans or reads from a cold disk can take a minute, so the slow end keeps steps
 * of its own rather than one "over 15 s".
 */
export function startupBucket(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 2_000) return "under-2s";
  if (value < 4_000) return "2-4s";
  if (value < 8_000) return "4-8s";
  if (value < 15_000) return "8-15s";
  if (value < 30_000) return "15-30s";
  if (value < 60_000) return "30-60s";
  return "over-60s";
}

const LAUNCH_KINDS = ["first-after-install", "first-after-update", "later"];

function startupTimingProperties(input: Readonly<Record<string, unknown>>) {
  closedEvent(input);
  const backendReadyMs = property(input, "backendReadyMs");
  const windowShownMs = property(input, "windowShownMs");
  return {
    launchKind: closedCategory(property(input, "launchKind"), LAUNCH_KINDS),
    platform: closedCategory(property(input, "platform"), [...PLATFORM_VALUES]),
    architecture: closedCategory(property(input, "architecture"), [...ARCHITECTURE_VALUES]),
    uiReadyBucket: startupBucket(property(input, "uiReadyMs")),
    ...(backendReadyMs === undefined ? {} : { backendReadyBucket: startupBucket(backendReadyMs) }),
    ...(windowShownMs === undefined ? {} : { windowShownBucket: startupBucket(windowShownMs) }),
    projectRestored: normalizedBoolean(property(input, "projectRestored")),
  };
}

function turnTerminalStatus(value: unknown): string {
  if (value === "cancelled" || value === "interrupted") return "stopped";
  return normalizedEnum(value, new Set(["completed", "failed", "stopped"]), "other");
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

// The UI sends these as categories it computed itself, never a path or title.
const VIEW_PROPERTIES = {
  "panel.viewed": ["category"],
  "settings.viewed": ["section"],
  "usage.viewed": ["metric", "window", "breakdown"],
  "usage.availability": ["state"],
  "feature.viewed": ["feature"],
} as const;

// The extensions a file tab reports. Any other extension is "other" and a name without one is
// "none", so an unusual extension can never identify a file or a person.
const FILE_TYPES: ReadonlySet<string> = new Set(
  [
    // Documents and writing
    "pdf md mdx markdown txt rtf doc docx odt pages epub html htm tex bib sty cls bbl typ rst org",
    // Slides and spreadsheets
    "ppt pptx odp key xls xlsx xlsm ods numbers csv tsv",
    // Structured text and configuration
    "json jsonl ndjson yaml yml toml xml ini cfg conf log lock diff patch",
    // Scientific and statistical data
    "parquet feather arrow h5 hdf5 nc mat npy npz pkl rds rdata rda dta sav sas7bdat sqlite sqlite3 db duckdb",
    "fits fit edf bdf nii dcm mzml fasta fa fastq fq bam sam vcf bed gff gtf pdb cif mol mol2 sdf xyz",
    "geojson shp kml gpx",
    // Code and notebooks
    "py ipynb r rmd qmd jl m mlx stan do sas sql js mjs cjs ts tsx jsx java c h cpp cc hpp cs go rs swift kt rb php",
    "sh bash zsh ps1 lua scala f f90 cu css scss vue svelte dart hs ex pl",
    // Images, video and audio
    "png jpg jpeg gif webp svg bmp tif tiff heic avif ico mp4 mov webm mkv avi mp3 wav m4a ogg flac",
    // Diagrams, archives and fonts
    "mmd mermaid drawio excalidraw zip tar gz tgz 7z rar bz2 xz ttf otf woff woff2",
  ].flatMap((group) => group.split(" ")),
);

function normalizedFileType(value: unknown): string {
  if (typeof value !== "string") return "other";
  const type = value.toLowerCase();
  return type === "none" || FILE_TYPES.has(type) ? type : "other";
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
  // Read without marking it: events that do not report a provider pass it through unchanged.
  const provider = normalizedProvider(
    Object.hasOwn(input, "provider") ? input.provider : undefined,
  );

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
          // How a process ended: macOS exit code 5 (SIGTRAP) is a Chromium CHECK, not memory.
          ...optionalProperties(input, { exitReason: PROCESS_EXIT_REASONS }),
          ...(Number.isSafeInteger(property(input, "exitCode"))
            ? { exitCode: property(input, "exitCode") as number }
            : {}),
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
          oldestEventAgeBucket: ageBucket(property(input, "oldestEventAgeMs")),
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
    case "provider.readiness.observed": {
      restrictProperties(input);
      const state = closedCategory(property(input, "state"), ["ready", "warning", "error"]);
      const failure = property(input, "checkFailure");
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider: closedCategory(property(input, "provider"), READINESS_PROVIDERS),
          state,
          runtimeSource: closedCategory(property(input, "runtimeSource"), [...RUNTIME_SOURCES]),
          ...(typeof failure === "string" &&
          STATUS_CHECK_FAILURES.has(failure) &&
          (state === "error" || state === "warning")
            ? { checkFailure: failure }
            : {}),
        },
      };
    }
    case "provider.readiness.changed":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          from: normalizedEnum(property(input, "from"), PROVIDER_STATES),
          to: normalizedEnum(property(input, "to"), PROVIDER_STATES),
          ...(property(input, "checkFailure") === undefined
            ? {}
            : {
                checkFailure: normalizedEnum(
                  property(input, "checkFailure"),
                  STATUS_CHECK_FAILURES,
                ),
              }),
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
    case "provider.lifecycle.cancelled": {
      const failed = name === "provider.lifecycle.failed";
      // Read on every lifecycle event so a stray value never passes through on the others.
      const failureClass = normalizedEnum(property(input, "failureClass"), FAILURE_CLASSES);
      const failureDetails = optionalProperties(input, {
        failedCheck: LIFECYCLE_FAILED_CHECKS,
        failureReason: SIGN_IN_FAILURE_REASONS,
      });
      const signInPage = optionalProperties(input, { signInPage: SIGN_IN_PAGES });
      return {
        name,
        privacyLevel: failed ? "essential" : "product",
        priority: failed ? "critical" : "core",
        properties: {
          provider,
          action: normalizedEnum(property(input, "action"), LIFECYCLE_ACTIONS),
          runtimeSource: normalizedEnum(property(input, "source"), RUNTIME_SOURCES),
          stage: normalizedEnum(property(input, "stage"), LIFECYCLE_STAGES),
          ...(failed ? { failureClass } : {}),
          durationBucket: durationBucket(property(input, "durationMs")),
          trigger: normalizedEnum(property(input, "trigger"), LIFECYCLE_TRIGGERS, "user"),
          ...optionalProperties(input, {
            attempt: "count",
            downloadSource: DOWNLOAD_SOURCES,
            sourceKind: DOWNLOAD_SOURCE_KINDS,
            downloadVariant: DOWNLOAD_VARIANTS,
            downloadAttempts: "count",
            networkKind: DOWNLOAD_NETWORK_KINDS,
            compressedFailure: FAILURE_CLASSES,
          }),
          ...(failed ? failureDetails : {}),
          // Every sign-in end says which page it waited on, so outcomes compare by page.
          ...(name === "provider.lifecycle.started" ? {} : signInPage),
          ...(property(input, "resumedBytes") === undefined
            ? {}
            : { resumedBucket: byteBucket(property(input, "resumedBytes")) }),
          ...(property(input, "progressPercent") === undefined
            ? {}
            : { progressBucket: percentBucket(property(input, "progressPercent")) }),
          ...(property(input, "bytesPerSecond") === undefined
            ? {}
            : { throughputBucket: throughputBucket(property(input, "bytesPerSecond")) }),
        },
      };
    }
    case "provider.runtime.first_pick":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          provider,
          state: normalizedEnum(property(input, "state"), FIRST_PICK_STATES),
          ...(property(input, "percent") === undefined
            ? {}
            : { percentBucket: percentBucket(property(input, "percent")) }),
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
          ...captureProperties(input, name !== "scient.operation.started"),
          ...(name === "scient.operation.started" ? {} : attributionProperties(input)),
          ...optionalProperties(input, {
            language: "identifier",
            actor: COMPUTE_ACTORS,
            entry: COMPUTE_ENTRIES,
            runtimeSource: COMPUTE_RUNTIME_SOURCES,
          }),
        },
      };
    case "provider.commands.observed":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          provider,
          modelKey: modelKey(property(input, "model")),
          commandCategory: closedCategory(property(input, "commandCategory"), COMMAND_CATEGORIES),
          commandCount: countOrZero(property(input, "commandCount")),
          failedCount: countOrZero(property(input, "failedCount")),
          ...optionalProperties(input, { stoppedCount: "count" }),
        },
      };
    case "app.update.outcome": {
      const properties = updateOutcomeProperties(input);
      return {
        name,
        privacyLevel: "essential",
        priority:
          properties.step === "install" || properties.step === "apply" ? "critical" : "core",
        properties,
      };
    }
    case "app.update.summary":
      return {
        name,
        privacyLevel: "essential",
        priority: "summary",
        properties: updateSummaryProperties(input),
      };
    case "app.startup.timing":
      return {
        name,
        privacyLevel: "essential",
        priority: "core",
        properties: startupTimingProperties(input),
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
          ...optionalProperties(input, { threadCount: "count", projectCount: "count" }),
        },
      };
    case "install.owner_observed": {
      const ownerId = property(input, "ownerId");
      const ownerSource = property(input, "ownerSource");
      // The id is already hashed; anything else must never leave the machine.
      if (
        typeof ownerId !== "string" ||
        !OWNER_ID_PATTERN.test(ownerId) ||
        typeof ownerSource !== "string" ||
        !OWNER_SOURCES.has(ownerSource)
      )
        return null;
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          ownerSource,
          ownerId,
          observedBy: normalizedEnum(property(input, "observedBy"), OWNER_OBSERVERS, "server"),
        },
      };
    }
    case "install.account_observed": {
      const rawEmail = property(input, "email");
      const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : undefined;
      const plan = shortLabel(property(input, "plan"));
      const accountType = shortLabel(property(input, "accountType"));
      const endpoint = accountEndpointProperties(input);
      const accountEmail =
        email !== undefined && isAllowedAccountEmail(name, "email", email) ? email : undefined;
      if (accountEmail === undefined && plan === undefined && accountType === undefined)
        return null;
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          provider: normalizedProvider(property(input, "provider")),
          ...(accountEmail === undefined ? {} : { email: accountEmail }),
          ...(plan === undefined ? {} : { plan }),
          ...(accountType === undefined ? {} : { accountType }),
          ...endpoint,
        },
      };
    }
    case "install.profile_observed": {
      // The UI sends a comma-separated list; its event properties are single values.
      const rawKinds = property(input, "workKinds");
      const kinds: ReadonlyArray<unknown> = Array.isArray(rawKinds)
        ? rawKinds
        : typeof rawKinds === "string"
          ? rawKinds.split(",")
          : [];
      const workKinds = kinds
        .map((kind) => (typeof kind === "string" ? kind.trim() : kind))
        .filter((kind): kind is string => isIdentifier(kind))
        .slice(0, 8);
      const field = shortLabel(property(input, "field"));
      const role = shortLabel(property(input, "role"));
      const otherWork = shortLabel(property(input, "otherWork"), 120);
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          workKinds,
          ...(field === undefined ? {} : { field }),
          ...(role === undefined ? {} : { role }),
          ...(otherWork === undefined ? {} : { otherWork }),
        },
      };
    }
    case "client.turn.requested":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: clientProperties(input),
      };
    case "client.thread.started":
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          ...clientProperties(input),
          workspaceStrategy: normalizedIdentifier(property(input, "workspaceStrategy"), "unknown"),
        },
      };
    case "feature.used":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          feature: normalizedIdentifier(property(input, "feature"), "other"),
          surface: normalizedEnum(property(input, "surface"), CLIENT_SURFACES),
          ...optionalProperties(input, { variant: "identifier" }),
        },
      };
    case "mcp.tool.invoked":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          tool: normalizedIdentifier(property(input, "tool"), "other"),
          callerProvider: normalizedProvider(property(input, "callerProvider")),
          outcome: normalizedEnum(property(input, "outcome"), TOOL_OUTCOMES, "error"),
          ...optionalModelKeys(input, ["callerModel", "targetModel"]),
          ...(property(input, "targetProvider") === undefined
            ? {}
            : { targetProvider: normalizedProvider(property(input, "targetProvider")) }),
          ...(property(input, "targetRuntimeMode") === undefined
            ? {}
            : { targetRuntimeMode: normalizedRuntimeMode(property(input, "targetRuntimeMode")) }),
          ...optionalProperties(input, {
            callerOrigin: TOOL_CALLER_ORIGINS,
            callerDepth: "count",
            durationMs: "count",
            errorCode: "identifier",
            failureClass: "identifier",
            targetInteractionMode: TOOL_INTERACTION_MODES,
            crossProvider: "boolean",
            targetChosen: "boolean",
            mode: TOOL_MODES,
            waitTimedOut: "boolean",
            batchSize: "count",
            workspace: TOOL_WORKSPACES,
            delivery: "identifier",
            bindToCurrentThread: "boolean",
          }),
          ...attributionProperties(input),
        },
      };
    case "mcp.delegated_task.finished":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          status: normalizedEnum(property(input, "status"), DELEGATED_TASK_STATUSES, "failed"),
          callerProvider: normalizedProvider(property(input, "callerProvider")),
          targetProvider: normalizedProvider(property(input, "targetProvider")),
          ...optionalModelKeys(input, ["callerModel", "targetModel"]),
          ...optionalProperties(input, {
            crossProvider: "boolean",
            completionWake: DELEGATED_TASK_WAKES,
            durationSeconds: "count",
            failureClass: TURN_FAILURE_CLASSES,
          }),
          ...failureCodeProperty(normalizedProvider(property(input, "targetProvider")), input),
          ...(property(input, "failurePhase") === undefined
            ? {}
            : {
                failurePhase: closedCategory(
                  property(input, "failurePhase"),
                  DELEGATED_TASK_FAILURE_PHASES,
                ),
              }),
          ...httpStatusProperty(input),
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
          ...(typeof property(input, "hasInput") === "boolean"
            ? { hasInput: property(input, "hasInput") as boolean }
            : {}),
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
      for (const key of VIEW_PROPERTIES[name]) {
        properties[key] = normalizedIdentifier(property(input, key), "other");
      }
      if (name === "panel.viewed" && Object.hasOwn(input, "fileType"))
        properties.fileType = normalizedFileType(property(input, "fileType"));
      return { name, privacyLevel: "product", priority: "core", properties };
    }
    case "latex.visual.opened":
    case "latex.visual.source-fallback": {
      restrictProperties(input);
      const outcome = closedCategory(
        property(input, "outcome"),
        name === "latex.visual.opened"
          ? ["editable", "source-only-content", "unavailable", "open-error"]
          : ["unavailable", "open-error"],
      );
      return {
        name,
        privacyLevel: "product",
        priority: "core",
        properties: {
          outcome,
          ...(outcome === "unavailable" || outcome === "open-error"
            ? { reason: closedCategory(property(input, "reason"), VISUAL_OPEN_FAILURES[outcome]) }
            : {}),
        },
      };
    }
    case "provider.turn.usage": {
      // The model that did the work, then the one the provider confirmed, then the selected one.
      // `observedModel` is read unmarked, so it is still sent as recorded.
      const observed =
        property(input, "mixedModels") === true || !Object.hasOwn(input, "observedModel")
          ? undefined
          : input.observedModel;
      const properties: Record<string, string | boolean | number> = {
        provider,
        modelKey: modelKey(property(input, "mainModel") ?? observed ?? property(input, "model")),
        terminalStatus: turnTerminalStatus(property(input, "terminalStatus")),
        usageStatus: normalizedEnum(
          property(input, "usageStatus"),
          new Set(["complete", "partial", "unavailable"]),
          "unavailable",
        ),
        usageScope: "main_agent",
      };
      Object.assign(
        properties,
        optionalProperties(input, {
          hasSubagents: "boolean",
          modelCount: "count",
          inputTokens: "count",
          outputTokens: "count",
          cachedInputTokens: "count",
          cacheCreationTokens: "count",
          reasoningTokens: "count",
          createdBy: TURN_ACTORS,
          creationSource: TURN_CREATION_SOURCES,
          scheduled: "boolean",
          subagent: "boolean",
        }),
      );
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
          ...optionalProperties(input, {
            browserToolCalls: "count",
            browserToolFailures: "count",
            retryAttempts: "count",
          }),
          ...turnRunProperties(input),
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
          ...optionalProperties(input, {
            browserToolCalls: "count",
            browserToolFailures: "count",
            retryAttempts: "count",
            // False when the run failed before its provider session started.
            started: "boolean",
            // Whose tool server failed to start, for a failure caused by one.
            toolServerOwner: TOOL_SERVER_OWNERS,
            // The request went to a custom API endpoint the user configured.
            customEndpoint: "boolean",
          }),
          ...turnRunProperties(input),
          ...failureCodeProperty(provider, input),
          ...httpStatusProperty(input),
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
          ...optionalProperties(input, { browserToolCalls: "count", browserToolFailures: "count" }),
          ...turnRunProperties(input),
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
          ...voiceProperties(input),
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
          ...voiceProperties(input),
        },
      };
    case "voice.recording.failed":
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
          ...(property(input, "voiceSchemaVersion") !== 2
            ? {}
            : {
                stage: closedCategory(property(input, "stage"), [
                  "preparing",
                  "transcribing",
                  "recording",
                  "delivering",
                ]),
                durationBucket: durationBucket(property(input, "durationMs")),
              }),
          ...voiceProperties(input),
        },
      };
    case "voice.recording.cancelled":
    case "voice.transcription.cancelled":
      return {
        name,
        privacyLevel: "product",
        priority: "summary",
        properties: {
          stage: normalizedEnum(property(input, "stage"), VOICE_CANCELLATION_STAGES),
          ...(property(input, "voiceSchemaVersion") !== 2
            ? {}
            : {
                durationBucket: durationBucket(property(input, "durationMs")),
              }),
          ...voiceProperties(input),
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
      // Like T3, an event without a Scient normalizer is still sent; its properties pass through.
      return { name, privacyLevel: "product", priority: "core", properties: {} };
  }
}

/** Public release coordinates only; custom build labels must never become identity hints. */
function analyticsAppVersion(value: string): string {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|nightly|rc|dev)(?:\.\d{1,14}){0,3})?$/u.test(value)
    ? value
    : "unknown";
}

// The gateway sets these on every event; an event's own copy would be confusing.
const RESERVED_KEYS = new Set([
  "source",
  "event_id",
  "distinct_id",
  "privacy_level",
  "consent_level",
  "identity_type",
  "productFirstSeenAt",
]);
function wireValue(value: unknown): WireValue | undefined {
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_PROPERTY_ITEMS)
      .filter(
        (item) => isWirePrimitive(item) && !(typeof item === "string" && isPrivateLooking(item)),
      );
    return items.length === value.length
      ? (items as ReadonlyArray<string | number | boolean>)
      : undefined;
  }
  if (!isWirePrimitive(value)) return undefined;
  return typeof value === "string" && isPrivateLooking(value) ? undefined : value;
}

function propertiesBytes(properties: Readonly<Record<string, WireValue>>): number {
  return new TextEncoder().encode(JSON.stringify(properties)).byteLength;
}

function normalizeReading(
  name: string,
  input: Readonly<Record<string, unknown>>,
  context: NormalizationContext,
): { readonly normalized: NormalizedEvent | null; readonly read: ReadonlySet<string> } {
  const read = new Set<string>();
  readKeys = read;
  try {
    return { normalized: normalizeEvent(name, input, context), read };
  } finally {
    readKeys = undefined;
  }
}

/**
 * The fields of `properties` that the event's Scient normalizer reads or sets. Every other field
 * passes through unchanged, so `normalizeInheritedEvent` sends it as recorded.
 */
export function normalizedKeys(
  name: string,
  properties: Readonly<Record<string, unknown>>,
  context: NormalizationContext,
): ReadonlySet<string> {
  const { normalized, read } = normalizeReading(name, properties, context);
  const set = normalized?.properties ?? {};
  return new Set(Object.keys(properties).filter((key) => read.has(key) || Object.hasOwn(set, key)));
}

/**
 * Shapes an event for the wire. A Scient normalizer, where one exists, decides the fields it
 * reads; every other field is sent as recorded, as in T3, after the shape and privacy checks.
 */
export function normalizeInheritedEvent(
  name: string,
  rawProperties: Readonly<Record<string, unknown>> | undefined,
  context: NormalizationContext,
): NormalizedEvent | null {
  if (!EVENT_NAME_PATTERN.test(name)) return null;
  const input = rawProperties ?? {};
  const { normalized, read } = normalizeReading(name, input, context);
  if (normalized === null) return null;

  const envelope = {
    appVersion: analyticsAppVersion(context.appVersion),
    buildChannel: normalizedEnum(context.buildChannel, BUILD_CHANNELS),
    contractRevision: ANALYTICS_CONTRACT_REVISION,
  };
  const properties: Record<string, WireValue> = {};
  for (const [key, value] of Object.entries(normalized.properties)) {
    const safe = isAllowedAccountEmail(name, key, value) ? (value as string) : wireValue(value);
    if (safe !== undefined) properties[key] = safe;
  }
  const room = MAX_EVENT_PROPERTIES - Object.keys(envelope).length;
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(properties).length >= room) break;
    if (
      read.has(key) ||
      Object.hasOwn(properties, key) ||
      Object.hasOwn(envelope, key) ||
      !PROPERTY_KEY_PATTERN.test(key) ||
      RESERVED_KEYS.has(key) ||
      isContentKey(key)
    )
      continue;
    const safe = wireValue(value);
    if (safe === undefined) continue;
    properties[key] = safe;
    if (propertiesBytes({ ...properties, ...envelope }) > MAX_EVENT_PROPERTIES_BYTES) {
      delete properties[key];
    }
  }
  return { ...normalized, properties: { ...properties, ...envelope } };
}
