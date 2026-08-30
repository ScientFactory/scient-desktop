import {
  type GrokSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  GROK_API_KEY_ENV,
  GROK_AUTH_EXTENSION_METHOD,
  GROK_AUTH_METHOD_CACHED_TOKEN,
  isValidGrokReasoningEffortToken,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import { discoverGrokSkills } from "../Drivers/GrokSkills.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_PROBE_TIMEOUT_MS = 15_000;
const GROK_ACCOUNT_METADATA_TIMEOUT_MS = 5_000;

const GrokInitializeMeta = Schema.Struct({
  modelState: Schema.optional(EffectAcpSchema.SessionModelState),
});
const decodeGrokInitializeMeta = Schema.decodeUnknownOption(GrokInitializeMeta);

const GrokAuthInfo = Schema.Struct({
  methodId: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokAuthInfo = Schema.decodeUnknownOption(GrokAuthInfo);

const GrokSubscriptionInfo = Schema.Struct({
  authenticated: Schema.Boolean,
  meta: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        email: Schema.optional(Schema.NullOr(Schema.String)),
        subscription_tier: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeGrokSubscriptionInfo = Schema.decodeUnknownOption(GrokSubscriptionInfo);

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in Scient settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grokReasoningOptionsFromModel(model: EffectAcpSchema.ModelInfo): {
  readonly options: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    isDefault?: boolean;
  }>;
  readonly currentValue: string | undefined;
} {
  const meta = model._meta;
  if (!meta || meta.supportsReasoningEffort === false) {
    return { options: [], currentValue: undefined };
  }

  const currentEffort = nonEmptyString(meta.reasoningEffort);
  const advertisedOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  const seen = new Set<string>();
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    advertisedDefault: boolean;
  }> = [];

  for (const entry of advertisedOptions) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawValue = nonEmptyString(entry.value);
    const rawId = nonEmptyString(entry.id);
    const value =
      rawValue && isValidGrokReasoningEffortToken(rawValue)
        ? rawValue
        : rawId && isValidGrokReasoningEffortToken(rawId)
          ? rawId
          : undefined;
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const description = nonEmptyString(entry.description);
    options.push({
      value,
      label: nonEmptyString(entry.label) ?? value,
      ...(description ? { description } : {}),
      advertisedDefault: entry.default === true || entry.isDefault === true,
    });
  }

  const currentValue =
    currentEffort && options.some((option) => option.value === currentEffort)
      ? currentEffort
      : undefined;
  const advertisedDefaults = options.filter((option) => option.advertisedDefault);
  const selectedDefault =
    advertisedDefaults.find((option) => option.value === currentValue)?.value ??
    advertisedDefaults[0]?.value;
  return {
    options: options.map(({ value, label, description }) => ({
      value,
      label,
      ...(description ? { description } : {}),
      ...(value === selectedDefault ? { isDefault: true } : {}),
    })),
    currentValue: currentValue ?? selectedDefault,
  };
}

export function buildGrokModelCapabilities(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const reasoning = grokReasoningOptionsFromModel(model);
  return reasoning.options.length > 0
    ? createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: reasoning.options.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.isDefault ? { isDefault: true } : {}),
            })),
            ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
          },
        ],
      })
    : EMPTY_CAPABILITIES;
}

export function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: buildGrokModelCapabilities(model),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

interface GrokAcpProbeResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly auth: ServerProviderAuth;
}

const probeGrokViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    // Initialization refreshes Grok's advertised auth/model state but does not
    // authenticate, create a session, or launch a browser.
    const initialized = yield* acp.initialize();
    const initializeMeta = decodeGrokInitializeMeta(initialized._meta);
    const models = Option.match(initializeMeta, {
      onNone: () => [],
      onSome: (meta) => buildGrokDiscoveredModelsFromSessionModelState(meta.modelState),
    });
    const methodIds = new Set(initialized.authMethods?.map((method) => method.id) ?? []);
    const hasAccount = methodIds.has(GROK_AUTH_METHOD_CACHED_TOKEN);
    if (!hasAccount) {
      const hasApiKey = Boolean(environment[GROK_API_KEY_ENV]?.trim());
      return {
        models,
        auth: hasApiKey
          ? {
              status: "authenticated",
              required: true,
              type: "api_key",
              label: "xAI API key",
            }
          : { status: "unauthenticated", required: true, type: "grok_account" },
      } satisfies GrokAcpProbeResult;
    }

    const [authInfo, subscriptionInfo] = yield* Effect.all([
      acp
        .request(GROK_AUTH_EXTENSION_METHOD.info, {})
        .pipe(Effect.timeoutOption(GROK_ACCOUNT_METADATA_TIMEOUT_MS), Effect.option),
      acp
        .request(GROK_AUTH_EXTENSION_METHOD.checkSubscription, {})
        .pipe(Effect.timeoutOption(GROK_ACCOUNT_METADATA_TIMEOUT_MS), Effect.option),
    ]);
    const decodedAuthInfo = Option.flatMap(authInfo, (value) =>
      Option.flatMap(value, decodeGrokAuthInfo),
    );
    const decodedSubscription = Option.flatMap(subscriptionInfo, (value) =>
      Option.flatMap(value, decodeGrokSubscriptionInfo),
    );
    const subscription = Option.getOrUndefined(decodedSubscription);
    const subscriptionMeta = subscription?.authenticated ? subscription.meta : undefined;
    const email = subscriptionMeta?.email ?? Option.getOrUndefined(decodedAuthInfo)?.email;
    const tier = subscriptionMeta?.subscription_tier;
    return {
      models,
      auth: {
        status: "authenticated",
        required: true,
        type: "grok_account",
        label: nonEmpty(tier) ?? "Grok subscription",
        ...(nonEmpty(email) ? { email: nonEmpty(email) } : {}),
      },
    } satisfies GrokAcpProbeResult;
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in Scient settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* discoverGrokSkills(grokSettings, environment, cwd);

  const probeExit = yield* probeGrokViaAcp(grokSettings, environment).pipe(
    Effect.timeoutOption(GROK_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Grok ACP readiness probe failed", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok is installed but its local agent did not start correctly.",
      },
    });
  }
  if (Option.isNone(probeExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP readiness probe timed out after ${GROK_ACP_PROBE_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok is installed but its local agent took too long to respond.",
      },
    });
  }
  const probe = probeExit.value.value;
  const discoveredModels = probe.models;
  const models =
    discoveredModels.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: probe.auth.status === "authenticated" ? "ready" : "warning",
      auth: probe.auth,
      ...(probe.auth.status === "unauthenticated"
        ? { message: "Sign in to Grok with the account that has your subscription." }
        : {}),
    },
  });
});

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
