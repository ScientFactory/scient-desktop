/**
 * AntigravityProvider — snapshot management and health probing for the
 * Antigravity (`agy`) provider.
 *
 * Verified against agy 1.1.17 (plan §11): `agy --version` prints a bare
 * version and exits 0, `agy models` prints tab-separated
 * `<slug>\t<Display Name>` records on stdout (progress chatter goes to
 * stderr). `agy models` is the provider-owned authentication and model
 * discovery check, so Scient never reads Antigravity credential material.
 *
 * @module AntigravityProvider
 */

import {
  PREFERRED_DEFAULT_ANTIGRAVITY_MODELS,
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

type LegacyAntigravitySettings = Pick<
  AntigravitySettings,
  "enabled" | "binaryPath" | "customModels"
>;

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const AgyModelEntry = Schema.Union([
  Schema.String,
  Schema.Struct({
    slug: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
  }),
]);
const AgyModelsJson = Schema.Union([
  Schema.Array(AgyModelEntry),
  Schema.Struct({ models: Schema.Array(AgyModelEntry) }),
]);
const decodeAgyModelsJson = Schema.decodeUnknownOption(AgyModelsJson);

function normalizeModelSlugs(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const value of values) {
    const slug = value.trim();
    if (!slug || !/^[a-z0-9][a-z0-9._:/+-]*$/iu.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Initial provider snapshot: settings-derived models plus the verified
 * `agy --version` probe shape (bare version string, exit 0).
 */
export function buildInitialAntigravityProviderSnapshot(
  antigravitySettings: LegacyAntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
          message: "Antigravity is disabled in Scient settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

function antigravityModelsFromSettings(
  customModels: LegacyAntigravitySettings["customModels"],
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Group raw model slugs like `gemini-3.7-flash-{low,medium,high}` into a
 * single base model with reasoning-effort capabilities.
 *
 * Verified against agy 1.1.17: effort suffixes are `-low`, `-medium`,
 * `-high` and only appear on Gemini flash/pro models. Slugs without an
 * effort suffix (e.g. `claude-sonnet-4-6`, `claude-opus-4-6-thinking`)
 * are standalone models and must not be split.
 */
export function groupAntigravityModels(
  rawSlugs: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const baseModels = new Map<
    string,
    { slug: string; name: string; efforts: Array<{ value: string; label: string }> }
  >();

  for (const slug of rawSlugs) {
    const trimmed = slug.trim();
    if (!trimmed) {
      continue;
    }

    // Match the verified effort suffixes only. A generic `-[a-z]+$` match
    // would corrupt slugs like `claude-opus-4-6-thinking` (splitting off
    // "thinking" as if it were an effort).
    const effortMatch = trimmed.match(/^(.+)-(low|medium|high)$/);
    const effortSuffix = effortMatch?.[2];
    const baseSlug = effortMatch?.[1] ?? trimmed;

    if (effortSuffix) {
      const existing = baseModels.get(baseSlug);
      if (existing) {
        existing.efforts.push({ value: effortSuffix, label: effortSuffix });
      } else {
        baseModels.set(baseSlug, {
          slug: baseSlug,
          name: antigravityModelDisplayName(baseSlug),
          efforts: [{ value: effortSuffix, label: effortSuffix }],
        });
      }
    } else {
      // No effort suffix — add as a standalone model.
      if (!baseModels.has(trimmed)) {
        baseModels.set(trimmed, {
          slug: trimmed,
          name: antigravityModelDisplayName(trimmed),
          efforts: [],
        });
      }
    }
  }

  // Order effort options low → medium → high regardless of discovery order.
  const EFFORT_ORDER = ["low", "medium", "high"];
  const models = Array.from(baseModels.values()).map((entry) => {
    entry.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a.value) - EFFORT_ORDER.indexOf(b.value));

    if (entry.efforts.length === 0) {
      return {
        slug: entry.slug,
        name: entry.name,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel;
    }

    // Collapse effort variants into a single model with reasoning effort options.
    const defaultEffort = entry.efforts.some((effort) => effort.value === "medium")
      ? "medium"
      : entry.efforts[0]?.value;
    const optionDescriptors = [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: "Reasoning",
        options: entry.efforts.map((effort) => ({
          value: effort.value,
          label: effort.label.charAt(0).toUpperCase() + effort.label.slice(1),
          isDefault: effort.value === defaultEffort,
        })),
      }),
    ];
    return {
      slug: entry.slug,
      name: entry.name,
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors }),
    } satisfies ServerProviderModel;
  });
  const preferredDefault = PREFERRED_DEFAULT_ANTIGRAVITY_MODELS.find((slug) =>
    models.some((model) => model.slug === slug),
  );
  return models.map((model) =>
    model.slug === preferredDefault ? { ...model, isDefault: true as const } : model,
  );
}

/**
 * Human-readable display name for a grouped Antigravity model slug.
 * Turns `gemini-3.7-flash` into "Gemini 3.7 Flash" and leaves
 * non-Gemini slugs (claude-*, gpt-*) mostly as-is with light cleanup.
 */
function antigravityModelDisplayName(baseSlug: string): string {
  return baseSlug
    .split("-")
    .map((part) =>
      /^\d/.test(part) || part.length <= 1 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

/**
 * Parse the output of `agy models` to extract model slugs.
 *
 * Verified against agy 1.1.17: stdout carries only tab-separated
 * `<slug>\t<Display Name>` records (the "Fetching available models..."
 * status line goes to stderr, which this parser never sees). JSON output
 * is accepted defensively for forward compatibility.
 */
export function parseAgyModelsOutput(output: string): ReadonlyArray<string> {
  const trimmed = output.trim();

  // Try JSON first (forward compatibility).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = decodeUnknownJson(trimmed);
      const decoded = decodeAgyModelsJson(parsed);
      if (Option.isSome(decoded)) {
        const entries = "models" in decoded.value ? decoded.value.models : decoded.value;
        return normalizeModelSlugs(
          entries.flatMap((entry) =>
            typeof entry === "string" ? [entry] : [entry.slug ?? entry.id ?? entry.name ?? ""],
          ),
        );
      }
    } catch {
      // Fall through to line-based parsing.
    }
  }

  // Line-based parsing for the verified tab-separated format:
  //   "gemini-3.7-flash-high\tGemini 3.7 Flash (High)"  (model record)
  // The slug is the first field before the tab; a bare slug with no tab is
  // also accepted. Comment lines and blanks are skipped.
  return normalizeModelSlugs(
    trimmed
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.split("\t", 1)[0] ?? line),
  );
}

export function isAgyModelsAuthenticationRequired(output: string): boolean {
  return /please\s+(?:sign|log)\s+in|not\s+(?:signed\s+in|logged\s+in|authenticated)|auth(?:entication)?\s+required|unauthori[sz]ed|missing\s+credentials/iu.test(
    output,
  );
}

export function isAgyApiKeyModeConfigurationError(output: string): boolean {
  return /GEMINI_API_KEY[^\n]*(?:not\s+(?:set|defined)|missing|required)|(?:not\s+(?:set|defined)|missing|required)[^\n]*GEMINI_API_KEY/iu.test(
    output,
  );
}

/**
 * Run an `agy` command with `stdin: "ignore"`.
 *
 * agy 1.1.17 keeps a language-server process alive when stdin stays open;
 * every probe here is one-shot, so stdin is always closed up front. Chat and
 * text-generation turns use the separate persistent stream-json transport.
 */
const runAgyCommand = (
  antigravitySettings: LegacyAntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = antigravitySettings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    const childCommand = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      extendEnv: false,
      shell: spawnCommand.shell,
      stdin: "ignore",
    });
    const child = yield* spawner.spawn(childCommand);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: MAX_PROBE_OUTPUT_BYTES,
          truncatedMarker: "\n[output truncated]",
        }).pipe(Effect.map((collected) => collected.text)),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: MAX_PROBE_OUTPUT_BYTES,
          truncatedMarker: "\n[output truncated]",
        }).pipe(Effect.map((collected) => collected.text)),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export interface AntigravityProbeResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function buildAntigravityCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Antigravity CLI command \`${binaryPath}\` was not found.`,
    `Install or enable the Antigravity CLI, make sure \`${binaryPath}\` is on PATH, then restart Scient.`,
  ].join(" ");
}

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    antigravitySettings: LegacyAntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
          message: "Antigravity is disabled in Scient settings.",
        },
      });
    }

    // Version probe with stdin: "ignore" (`agy --version`, verified 1.1.17).
    const versionResult = yield* runAgyCommand(
      antigravitySettings,
      ["--version"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Antigravity CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
          message: isCommandMissingCause(error)
            ? buildAntigravityCliCommandMissingMessage(antigravitySettings.binaryPath || "agy")
            : "Failed to execute Antigravity CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
          message: "Antigravity CLI is installed but timed out while running `agy --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    if (versionOutput.code !== 0) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown", required: true, type: "oauth", label: "Google account" },
          message: "Antigravity CLI is installed, but `agy --version` failed.",
        },
      });
    }
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

    // `agy models` is both the provider-owned authentication check and model
    // discovery surface. The driver supplies an account-only environment, so
    // this validates Google's subscription login through the native keyring
    // without Scient reading any provider credential file.
    let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
    let discoveryWarning: string | undefined = version
      ? undefined
      : "Antigravity CLI did not report a recognizable version.";
    let auth: ServerProviderAuth = {
      status: "unknown",
      required: true,
      type: "oauth",
      label: "Google account",
    };
    let authenticationWarning: string | undefined;
    const discoveryOutcome = yield* runAgyCommand(
      antigravitySettings,
      ["models"],
      environment,
    ).pipe(Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(discoveryOutcome)) {
      yield* Effect.logWarning("Antigravity model discovery failed", {
        errorTag: discoveryOutcome.failure._tag,
      });
      discoveryWarning = "Antigravity model discovery failed. Check server logs for details.";
    } else if (Option.isNone(discoveryOutcome.success)) {
      discoveryWarning = `Antigravity model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else {
      const discoveryResult = discoveryOutcome.success.value;
      const combinedOutput = `${discoveryResult.stdout}\n${discoveryResult.stderr}`;
      if (discoveryResult.code === 0) {
        const rawSlugs = parseAgyModelsOutput(discoveryResult.stdout);
        discoveredModels = groupAntigravityModels(rawSlugs);
        auth = { ...auth, status: "authenticated" };
        if (discoveredModels.length === 0) {
          discoveryWarning = "Antigravity authenticated successfully but returned no models.";
        }
      } else if (isAgyApiKeyModeConfigurationError(combinedOutput)) {
        auth = { ...auth, status: "unauthenticated" };
        authenticationWarning =
          "Antigravity is configured for Gemini API-key mode, which Scient intentionally does not use. Remove `modelProvider` from `~/.gemini/antigravity-cli/settings.json`, then sign in with Google.";
      } else if (isAgyModelsAuthenticationRequired(combinedOutput)) {
        auth = { ...auth, status: "unauthenticated" };
      } else {
        discoveryWarning =
          "Antigravity could not verify the connected account or discover available models.";
      }
    }

    const models = antigravityModelsFromSettings(
      antigravitySettings.customModels,
      discoveredModels,
    );

    const status: Exclude<ServerProviderState, "disabled"> =
      auth.status === "unauthenticated" ? "error" : discoveryWarning ? "warning" : "ready";

    const message =
      [
        auth.status === "unauthenticated"
          ? (authenticationWarning ??
            "Antigravity is not authenticated. Start the Antigravity sign-in flow and complete Google sign-in.")
          : undefined,
        discoveryWarning,
      ]
        .filter((v): v is string => v !== undefined)
        .join(" ") || undefined;

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: antigravitySettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status,
        auth,
        ...(message ? { message } : {}),
      },
    });
  },
);

/**
 * Background maintenance enrichment for an Antigravity snapshot.
 *
 * Used by `AntigravityDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery.
 */
export const enrichAntigravitySnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Antigravity version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
