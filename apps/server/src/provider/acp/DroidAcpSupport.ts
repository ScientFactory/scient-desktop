import {
  DROID_DEFAULT_MODEL,
  type DroidSettings,
  type RuntimeMode,
  type ServerProviderModel,
  type ModelConnectionReadiness,
} from "@t3tools/contracts";
import { createModelCapabilities, preferredReasoningLevel } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
// SCIENT-FORK:START — legacy v1 adapter vocabulary.
// Upstream replaced `effect-acp/schema` with the generated ACP v2 wire types
// and moved the pre-v2 hand-written module to `effect-acp/compat`. This
// adapter was written against the pre-v2 module, so it imports `compat`.
import type * as EffectAcpSchema from "effect-acp/compat";
// SCIENT-FORK:END

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { CustomModelReasoning } from "../../customModelCapabilities.ts";
import type { DroidRequestLimitBreach } from "../droid/DroidKeyBroker.ts";

/**
 * Droid ACP ignores -m/-r: select through config requests, then await post-ack async confirmation.
 * Effort ladders belong only to the selected model; modes also appear as autonomy_level. Keep
 * version-sensitive assumptions pinned by DroidAcpCliProbe.test.ts.
 */

/** Compatibility marker advertised by genuine Droid ACP agents. */
export const DROID_AGENT_INFO_NAME = "@factory/cli";

const DROID_AUTH_METHOD_API_KEY = "factory-api-key";
export const DROID_AUTH_METHOD_DEVICE_PAIRING = "device-pairing";

export interface DroidAccountCapabilities {
  readonly devicePairing: boolean;
  readonly logout: boolean;
}

export function droidAccountCapabilitiesFromInitializeResult(
  result: EffectAcpSchema.InitializeResponse,
): DroidAccountCapabilities {
  return {
    devicePairing: (result.authMethods ?? []).some(
      (method) => method.id === DROID_AUTH_METHOD_DEVICE_PAIRING,
    ),
    logout: result.agentCapabilities?.auth?.logout != null,
  };
}

const DROID_EFFORT_CONFIG_ID = "reasoning_effort";
const DROID_AUTONOMY_CONFIG_ID = "autonomy_level";

/** Env vars whose presence selects key-based auth for probes and sessions. */
const DROID_API_KEY_ENV_KEYS: ReadonlyArray<string> = ["FACTORY_API_KEY"];

type DroidAcpRuntimeDroidSettings = Pick<DroidSettings, "binaryPath"> &
  Partial<Pick<DroidSettings, "cloudSessionSync">>;

export interface DroidAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "configOptionTransport" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly droidSettings: DroidAcpRuntimeDroidSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Passed through Droid's argv; keep this bounded and free of secrets. */
  readonly systemPrompt?: string;
  /** Extra client capabilities (e.g. the probe's parameterized-model-picker). */
  readonly clientCapabilities?: AcpSessionRuntime.AcpSessionRuntimeOptions["clientCapabilities"];
  /** Passive status probes skip authentication and classify `session/new`. */
  readonly authenticationMode?: "active" | "passive";
  /** Per-process Droid settings overlay. It holds broker capabilities; never log its contents. */
  readonly runtimeSettingsPath?: string;
  /**
   * Droid still advertises tools to Factory-hosted models in ACP. Only the custom-model overlay
   * hook/broker can enforce disabled tools; the plain factory must refuse rather than launch with
   * tools enabled.
   */
  readonly modelTools?: "disabled";
}

export type DroidAcpRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"] & {
  readonly assessModelConnections?: (
    models: ReadonlyArray<ServerProviderModel>,
  ) => ReadonlyArray<ModelConnectionReadiness>;
  /** Synchronous process snapshot: null is managed but unknown; undefined is native. */
  readonly getReasoningMetadata?: (modelId: string) => CustomModelReasoning | null | undefined;
  readonly getDefaultReasoningLevel?: (modelId: string) => string | undefined;
  /** Loaded custom-model configuration; undefined leaves native Droid models alone. */
  readonly getImageSupport?: (modelId: string) => boolean | undefined;
  /** Why Droid does not list a Scient model; undefined for native models. */
  readonly describeUnavailableModel?: (modelId: string) => string | undefined;
  /** Context window this process gave a loaded custom model; undefined when not known. */
  readonly getContextWindow?: (modelId: string) => number | undefined;
  /** False for a pending next-turn generation as well as a retired process. */
  readonly isConfigurationCurrent?: () => boolean;
  readonly isConfigurationRetired?: () => boolean;
  readonly checkConfiguration?: () => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Starts the custom-model request budget of a new turn. Prompts that
   * continue a turn (steers) keep its budget, so a breach sticks for the turn.
   */
  readonly beginTurn?: Effect.Effect<void>;
  readonly beginRunBudget?: (threadId: string, runId: string) => Effect.Effect<void>;
  /** Set when Scient ended the current turn at its custom-model request limit. */
  readonly requestLimitBreach?: () => DroidRequestLimitBreach | undefined;
  /**
   * Completes with the current turn's first 429 or 5xx answer from a custom
   * model's endpoint, which Droid then retries without telling the user.
   */
  readonly upstreamRetrying?: Effect.Effect<number>;
  /**
   * An organization policy can disable the overlay hook. Verify tool-call refusal after startup
   * even when the custom endpoint was offered no tools, because it can still return a tool call.
   */
  readonly backgroundToolGuard?: () => Effect.Effect<DroidToolGuard>;
};

/** Shorter values would be cut out of ordinary words. */
const MIN_REDACTED_CREDENTIAL_CHARS = 8;
/** What Droid holds in place of a custom model's key: see `DroidKeyBroker`. */
const DROID_BROKER_CAPABILITY = /scient-cap-[A-Za-z0-9_-]{16,}/g;

/**
 * Redact only exact configured credentials and broker capabilities from shown/stored Droid text. A
 * custom model's own key must never reach Droid.
 */
export function makeDroidCredentialRedactor(input: {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly sensitiveValues?: ReadonlyArray<string> | undefined;
}): (text: string) => string {
  const credentials = [
    ...new Set([input.environment?.FACTORY_API_KEY, ...(input.sensitiveValues ?? [])]),
  ]
    .flatMap((value) =>
      value !== undefined && value.length >= MIN_REDACTED_CREDENTIAL_CHARS ? [value] : [],
    )
    // Longest first: a value that contains another goes whole.
    .toSorted((left, right) => right.length - left.length);
  return (text) =>
    credentials.reduce(
      (next, credential) => next.replaceAll(credential, "[redacted]"),
      text.replace(DROID_BROKER_CAPABILITY, "[redacted]"),
    );
}

/**
 * The cause Droid gives for a failed request. Up to 0.235 Droid sends it as the
 * error's `data` text, after a generic "Internal error: Agent error" message.
 * From 0.241 `data` is `{ reason, sessionId }` and the cause follows
 * "Internal error: " in the message itself.
 */
export function droidRequestFailureDetail(error: EffectAcpErrors.AcpRequestError): string {
  return typeof error.data === "string" && error.data.trim()
    ? error.data.trim()
    : error.errorMessage.replace(/^Internal error:\s*/u, "").trim();
}

/** `unconfirmed`: a policy may disable the guard, or Droid did not show it runs. */
export type DroidToolGuard = "enforced" | "disabled-by-policy" | "unconfirmed";
export type DroidAcpRuntimeFactory = (
  input: DroidAcpRuntimeInput,
) => Effect.Effect<DroidAcpRuntime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>;

/** One command authority for health probes, ACP sessions, and text generation. */
export function resolveDroidCliBinaryPath(configuredPath: string | null | undefined): string {
  const trimmed = configuredPath?.trim();
  return trimmed || "droid";
}

export function buildDroidAcpSpawnInput(
  droidSettings: DroidAcpRuntimeDroidSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  systemPrompt?: string,
  runtimeSettingsPath?: string,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: resolveDroidCliBinaryPath(droidSettings?.binaryPath),
    args: [
      ...(runtimeSettingsPath ? ["--settings", runtimeSettingsPath] : []),
      "exec",
      "--output-format",
      "acp",
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ],
    cwd,
    // The caller's environment is the complete child environment (the agent
    // environment contract), never merged back over the server's own.
    ...(environment ? { env: environment, extendEnv: false } : {}),
  };
}

export function hasDroidApiKeyEnvironment(environment: NodeJS.ProcessEnv | undefined): boolean {
  return DROID_API_KEY_ENV_KEYS.some((key) => Boolean(environment?.[key]?.trim()));
}

/**
 * Auth selection before `initialize` advertises the real method list: prefer
 * the noninteractive API key when the environment carries one, else fall
 * back to device-pairing (which authenticates headlessly whenever a cached
 * pairing exists). `_meta.headless` keeps every path browser-free.
 */
export function resolveDroidAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return hasDroidApiKeyEnvironment(environment)
    ? DROID_AUTH_METHOD_API_KEY
    : DROID_AUTH_METHOD_DEVICE_PAIRING;
}

/**
 * Resolves the auth method against the actually advertised list. Returns
 * `undefined` when nothing matches so callers can classify honestly instead
 * of attempting an interactive flow.
 */
export function resolveAdvertisedDroidAuthMethodId(input: {
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly advertisedAuthMethods: ReadonlyArray<string>;
}): string | undefined {
  const advertised = new Set(input.advertisedAuthMethods);
  if (hasDroidApiKeyEnvironment(input.environment) && advertised.has(DROID_AUTH_METHOD_API_KEY)) {
    return DROID_AUTH_METHOD_API_KEY;
  }
  if (advertised.has(DROID_AUTH_METHOD_DEVICE_PAIRING)) {
    return DROID_AUTH_METHOD_DEVICE_PAIRING;
  }
  return undefined;
}

/**
 * Headless authenticate metadata. Background probes must never open a
 * pairing browser; Droid honors `_meta.headless` on `authenticate`.
 */
const DROID_HEADLESS_AUTH_META = { headless: true } as const;

export const makeDroidAcpRuntime = Effect.fn("DroidAcpSupport.makeDroidAcpRuntime")(function* (
  input: DroidAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const { authenticationMode = "active", runtimeSettingsPath, modelTools, ...runtimeInput } = input;
  if (modelTools === "disabled")
    return yield* new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Scient cannot run Droid without tools in this process.",
    });
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeInput,
      spawn: buildDroidAcpSpawnInput(
        input.droidSettings,
        input.cwd,
        input.environment,
        input.systemPrompt,
        runtimeSettingsPath,
      ),
      authMethodId:
        authenticationMode === "passive"
          ? undefined
          : (initializeResult) =>
              resolveAdvertisedDroidAuthMethodId({
                environment: input.environment,
                advertisedAuthMethods: (initializeResult.authMethods ?? []).map(
                  (method) => method.id,
                ),
              }),
      authenticateMeta: DROID_HEADLESS_AUTH_META,
      // Droid answers config writes with {} before publishing applied state. Wait for a
      // config_option_update after that answer; neither an empty acknowledgement nor earlier
      // evidence confirms autonomy or another write.
      configOptionTransport: "request-confirmed",
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

// ── Config-option parsing ────────────────────────────────────────────────

export interface DroidDiscoveredEffortLevel {
  readonly value: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

export interface DroidDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  /** Whether this model's model-dependent option surface was actually observed. */
  readonly capabilitiesObserved: boolean;
  readonly currentEffortValue: string | undefined;
  readonly efforts: ReadonlyArray<DroidDiscoveredEffortLevel>;
  /**
   * Compact provider-reported cost label (e.g. `"0.5×"`) extracted from the
   * option's `description` ("0.5x Factory token rate"); undefined when the
   * description carries no leading multiplier.
   */
  readonly providerCostLabel: string | undefined;
  /** Set when Droid runs another level than the one configured for this Scient model. */
  readonly replacedDefault?: DroidReplacedDefault | undefined;
}

/**
 * Accept only a leading Factory rate multiplier as a cost badge; prose descriptions must degrade to
 * no badge rather than an invented number.
 */
export function droidCostMultiplierLabel(
  description: string | null | undefined,
): string | undefined {
  const multiplier = description?.trim().match(/^(\d+(?:\.\d+)?)x(?:\s|$)/i)?.[1];
  return multiplier ? `${multiplier}×` : undefined;
}

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ value: string; label: string; description: string | undefined }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            label: entry.name.trim(),
            description: entry.description?.trim() || undefined,
          },
        ]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          label: nested.name.trim(),
          description: nested.description?.trim() || undefined,
        })),
  );
}

function findSelectOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  predicate: (option: EffectAcpSchema.SessionConfigOption) => boolean,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) return undefined;
  return configOptions.find((option) => option.type === "select" && predicate(option));
}

const isModelConfigOption = (option: EffectAcpSchema.SessionConfigOption): boolean =>
  option.category?.trim().toLowerCase() === "model" || option.id.trim().toLowerCase() === "model";

const isEffortConfigOption = (option: EffectAcpSchema.SessionConfigOption): boolean =>
  option.category?.trim().toLowerCase() === "thought_level" ||
  option.id.trim().toLowerCase() === "reasoning_effort";

function effortLevelsFromOption(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<DroidDiscoveredEffortLevel> {
  if (option.type !== "select") return [];
  return flattenSelectOptions(option).flatMap((entry) =>
    entry.value
      ? [
          {
            value: entry.value,
            label: entry.label || entry.value,
          } satisfies DroidDiscoveredEffortLevel,
        ]
      : [],
  );
}

/**
 * A config snapshot's effort ladder belongs only to its selected model. Leave other ladders empty
 * until selected, or the picker would advertise efforts Droid rejects.
 */
export function buildDroidModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DroidDiscoveredModel> {
  if (!configOptions || configOptions.length === 0) return [];
  const modelOption = findSelectOption(configOptions, isModelConfigOption);
  if (!modelOption) return [];
  const selectedModelValue =
    typeof modelOption.currentValue === "string" ? modelOption.currentValue.trim() : undefined;
  const effortOption = findSelectOption(configOptions, isEffortConfigOption);
  // The effort ladder is model-dependent for both Factory-managed and BYOK
  // models. Droid refreshes this option after the model switch, so the
  // selected model's live snapshot is the authority; `custom:` identifies
  // ownership, not a reason to discard an observed capability.
  const currentEfforts = effortOption ? effortLevelsFromOption(effortOption) : [];
  const currentEffortValue =
    typeof effortOption?.currentValue === "string" ? effortOption.currentValue.trim() : undefined;
  return flattenSelectOptions(modelOption).flatMap((entry) =>
    entry.value
      ? [
          {
            slug: entry.value,
            name: entry.label || entry.value,
            capabilitiesObserved: entry.value === selectedModelValue,
            ...(entry.value === selectedModelValue
              ? { currentEffortValue, efforts: currentEfforts }
              : { currentEffortValue: undefined, efforts: [] }),
            providerCostLabel: droidCostMultiplierLabel(entry.description),
          } satisfies DroidDiscoveredModel,
        ]
      : [],
  );
}

export function findDroidAutonomyOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  // An ordinary mode picker can precede the dedicated autonomy option.
  // Prefer its identity before falling back to the provider's category.
  return (
    findSelectOption(
      configOptions,
      (option) => option.id.trim().toLowerCase() === DROID_AUTONOMY_CONFIG_ID,
    ) ??
    findSelectOption(configOptions, (option) => option.category?.trim().toLowerCase() === "mode")
  );
}

/** Droid can change autonomy itself; confirm its reported level before each prompt. */
export const confirmDroidAutonomy = Effect.fn("DroidAcpSupport.confirmAutonomy")(function* (
  runtime: Pick<DroidAcpRuntime, "getConfigOptions" | "setConfigOption">,
  requestedId: string,
) {
  const refuse = (detail: string) =>
    new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: detail });
  const option = findDroidAutonomyOption(yield* runtime.getConfigOptions);
  if (!option)
    return yield* refuse(
      `Droid does not offer an autonomy level, so the message was not sent at "${requestedId}".`,
    );
  if (option.currentValue !== requestedId) yield* runtime.setConfigOption(option.id, requestedId);
  const applied = findDroidAutonomyOption(yield* runtime.getConfigOptions)?.currentValue;
  if (applied !== requestedId)
    return yield* refuse(
      `Droid reported the "${String(applied)}" autonomy level instead of "${requestedId}", so the message was not sent.`,
    );
});

/**
 * Resolves a select-type config option by id or category, case-insensitively.
 * Shared by adapter helpers that must address Droid's option ids
 * (`model`, `reasoning_effort`) without assuming a snapshot layout.
 */
export function findSelectDroidConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  input: { readonly category?: string; readonly id?: string },
): EffectAcpSchema.SessionConfigOption | undefined {
  const categoryId = input.category?.trim().toLowerCase();
  const optionId = input.id?.trim().toLowerCase();
  if (!categoryId && !optionId) return undefined;
  return (
    (optionId === undefined
      ? undefined
      : findSelectOption(configOptions, (option) => option.id.trim().toLowerCase() === optionId)) ??
    (categoryId === undefined
      ? undefined
      : findSelectOption(
          configOptions,
          (option) => option.category?.trim().toLowerCase() === categoryId,
        ))
  );
}

// ── Model/effort application (shared adapter + text-generation logic) ────

/**
 * Minimal runtime surface needed to apply a model/effort selection. A
 * structural type so both the live session runtime and test doubles satisfy
 * it without importing the full service.
 */
export interface DroidModelEffortRuntime {
  readonly getDefaultReasoningLevel?: DroidAcpRuntime["getDefaultReasoningLevel"];
  readonly getReasoningMetadata?: DroidAcpRuntime["getReasoningMetadata"];
  readonly describeUnavailableModel?: DroidAcpRuntime["describeUnavailableModel"];
  readonly setModel: (modelId: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly getConfigOptions: Effect.Effect<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    EffectAcpErrors.AcpError
  >;
  readonly setConfigOption: (
    configOptionId: string,
    value: string,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/** Extracts a `reasoningEffort` select value from composer model options. */
export function requestedDroidEffortFromSelection(
  options:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | null
    | undefined,
): string | undefined {
  const effort = options?.find((entry) => entry.id === "reasoningEffort");
  return typeof effort?.value === "string" && effort.value.trim() ? effort.value.trim() : undefined;
}

/**
 * A model Droid does not list fails with the reason instead of Droid's whole
 * model list: a Scient model's connection says what changed (key, removal,
 * Use with); a native model is no longer offered by this Droid.
 */
const requireOfferedDroidModel = Effect.fn("DroidAcpSupport.requireOfferedDroidModel")(function* (
  runtime: DroidModelEffortRuntime,
  modelId: string,
) {
  const modelOption = findSelectDroidConfigOption(yield* runtime.getConfigOptions, {
    category: "model",
    id: "model",
  });
  if (
    modelOption === undefined ||
    flattenSelectOptions(modelOption).some((entry) => entry.value === modelId)
  )
    return;
  return yield* new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage:
      runtime.describeUnavailableModel?.(modelId) ??
      `Droid no longer offers "${modelId}". Pick another model.`,
    data: { configId: modelOption.id, receivedValue: modelId },
  });
});

/**
 * Apply model before effort and validate against its live ladder. A configured default is a wish:
 * Droid may choose its nearest supported level, which must be returned. Explicit conversation
 * choices other than that default must be applied exactly; inherited managed efforts still need
 * evidence.
 */
const configureDroidModelAndEffort = Effect.fn("DroidAcpSupport.configureDroidModelAndEffort")(
  function* (input: {
    readonly runtime: DroidModelEffortRuntime;
    readonly requestedModel: string | undefined;
    readonly requestedEffort: string | undefined;
    readonly validationOnly?: boolean;
  }): Effect.fn.Return<DroidReplacedDefault | undefined, EffectAcpErrors.AcpError> {
    let requestedEffort = input.requestedEffort;
    // The Droid default and a blank model are no choice: Droid keeps its own.
    const trimmedModel = input.requestedModel?.trim();
    const requestedModel =
      trimmedModel && trimmedModel !== DROID_DEFAULT_MODEL ? trimmedModel : undefined;
    if (requestedModel !== undefined) {
      yield* requireOfferedDroidModel(input.runtime, requestedModel);
      yield* input.runtime.setModel(requestedModel);
    }
    if (requestedEffort === undefined && !input.runtime.getReasoningMetadata) {
      return;
    }
    const configOptions = yield* input.runtime.getConfigOptions;
    const effortOption = findSelectDroidConfigOption(configOptions, {
      id: DROID_EFFORT_CONFIG_ID,
      category: "thought_level",
    });
    const modelOption = findSelectDroidConfigOption(configOptions, {
      category: "model",
      id: "model",
    });
    const metadata =
      typeof modelOption?.currentValue === "string"
        ? input.runtime.getReasoningMetadata?.(modelOption.currentValue)
        : undefined;
    // Droid applies no reasoning to a Scient model its overlay gave no effort:
    // every write reports `none`, and nothing is sent. A saved or stale level
    // for it is therefore not written (Scient shows no reasoning control).
    if (metadata !== undefined && !droidConfiguresEffort(metadata)) return;
    const preference =
      typeof modelOption?.currentValue === "string"
        ? input.runtime.getDefaultReasoningLevel?.(modelOption.currentValue)
        : undefined;
    // Droid keeps the previous model's effort across a switch, so a managed
    // model without an explicit choice gets its configured level written
    // (verified against Droid 0.213.0 and 0.230.0).
    let configuredDefault: string | undefined;
    if (
      !input.validationOnly &&
      metadata?.status === "known" &&
      metadata.supported &&
      effortOption?.type === "select"
    ) {
      const supported = effortOption.options
        .flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
        )
        .filter((level) => droidMetadataAllowsEffort(metadata, level));
      configuredDefault = preferredReasoningLevel(supported, metadata.defaultLevel, preference);
      requestedEffort ??= configuredDefault;
    }
    const effectiveEffort =
      requestedEffort ??
      (typeof effortOption?.currentValue === "string" ? effortOption.currentValue : undefined);
    if (
      metadata?.status === "known" &&
      effectiveEffort !== undefined &&
      !droidMetadataAllowsEffort(metadata, effectiveEffort)
    ) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Droid runtime reasoning effort "${effectiveEffort}" conflicts with the selected model's provider metadata. Select a supported effort before sending.`,
        data: { receivedValue: effectiveEffort },
      });
    }
    if (requestedEffort === undefined) return;
    if (effortOption?.type !== "select") {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Reasoning effort "${requestedEffort}" is not available for the selected model.`,
        data: { allowed: [], receivedValue: requestedEffort },
      });
    }
    const allowed = effortOption.options.flatMap((entry) =>
      "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
    );
    if (!allowed.includes(requestedEffort)) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Reasoning effort "${requestedEffort}" is not available for the selected model (expected one of: ${allowed.join(", ")}).`,
        data: { allowed, receivedValue: requestedEffort },
      });
    }
    const isDefault = requestedEffort === configuredDefault;
    const replaced = yield* input.runtime.setConfigOption(effortOption.id, requestedEffort).pipe(
      Effect.as(undefined),
      Effect.catch((error) => {
        const described = describeDroidAppliedValue(error);
        // Droid reported another level: for the default, the readback below decides.
        return isDefault && described !== error
          ? Effect.succeed(described)
          : Effect.fail(described);
      }),
    );
    if (metadata === undefined) return;
    // Detect a runtime-reported clamp. This is ACP state, not proof that
    // the upstream API honored reasoning (ACP can acknowledge optimistically).
    const after = yield* input.runtime.getConfigOptions;
    // The level was judged for the selected model: a report that names another
    // model is not about it, whatever level it carries.
    const modelAfter = findSelectDroidConfigOption(after, { category: "model", id: "model" });
    if (modelAfter?.currentValue !== modelOption?.currentValue) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Droid reported the model "${modelAfter?.currentValue ?? "unknown"}" instead of "${modelOption?.currentValue ?? "unknown"}" after the reasoning effort was set, so the message was not sent.`,
      });
    }
    const reported = findSelectDroidConfigOption(after, { id: effortOption.id })?.currentValue;
    if (reported === requestedEffort) return;
    if (isDefault && typeof reported === "string" && droidMetadataAllowsEffort(metadata, reported))
      return { configured: requestedEffort, applied: reported };
    return yield* (
      replaced ??
        new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Droid did not retain the requested reasoning effort "${requestedEffort}". The runtime reported "${reported ?? "unknown"}"; the prompt was not sent.`,
        })
    );
  },
);

/** The configured default of a Scient model and the level Droid runs in its place. */
export interface DroidReplacedDefault {
  readonly configured: string;
  readonly applied: string;
}

const droidEffortLabel = (level: string) =>
  level === "xhigh" ? "Extra-high" : level.charAt(0).toUpperCase() + level.slice(1);

/** What a thread says, once, when it runs at another level than the configured default. */
export const droidReplacedDefaultNotice = (replaced: DroidReplacedDefault) =>
  `Droid uses ${droidEffortLabel(replaced.applied)} for this model instead of the configured default ${droidEffortLabel(replaced.configured)}.`;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const AppliedConfigValue = Schema.Struct({
  configId: Schema.String,
  requestedValue: Schema.Union([Schema.String, Schema.Boolean]),
  appliedValue: Schema.NullOr(Schema.Union([Schema.String, Schema.Boolean])),
});
const decodeAppliedConfigValue = Schema.decodeUnknownOption(AppliedConfigValue);

/** Names the value Droid reported applying when it differs from the write. */
function describeDroidAppliedValue(error: EffectAcpErrors.AcpError): EffectAcpErrors.AcpError {
  if (!isAcpRequestError(error)) return error;
  const applied = decodeAppliedConfigValue(error.data);
  if (Option.isNone(applied) || applied.value.configId !== DROID_EFFORT_CONFIG_ID) return error;
  const { requestedValue, appliedValue } = applied.value;
  return new EffectAcpErrors.AcpRequestError({
    code: error.code,
    errorMessage: `Droid applied reasoning effort ${appliedValue === null ? "no value" : JSON.stringify(appliedValue)} instead of ${JSON.stringify(requestedValue)}, so the message was not sent.`,
    data: error.data,
    cause: error,
  });
}

export const applyDroidModelAndEffort = (input: {
  readonly runtime: DroidModelEffortRuntime;
  readonly requestedModel: string | undefined;
  readonly requestedEffort: string | undefined;
}) => configureDroidModelAndEffort(input);

/** Check the current state without replacing a conversation choice with a saved default. */
export const validateDroidReasoningState = (runtime: DroidModelEffortRuntime) =>
  configureDroidModelAndEffort({
    runtime,
    requestedModel: undefined,
    requestedEffort: undefined,
    validationOnly: true,
  }).pipe(Effect.asVoid);

/**
 * Maps Scient runtime modes onto Droid's graduated autonomy ladder. The
 * input is the contract's `RuntimeMode` union and the mapping is exhaustive
 * (the `never` guard fails typecheck when a mode is added to the contract),
 * so a new value cannot silently fall through to a wrong autonomy tier.
 */
export function resolveDroidAutonomyModeId(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "normal";
    case "auto-accept-edits":
      return "auto-low";
    case "auto":
      return "auto-medium";
    case "full-access":
      return "auto-high";
    default: {
      // Compile-time exhaustiveness guard: adding a contract RuntimeMode
      // without a mapping here is a type error.
      const unhandledMode: never = runtimeMode;
      return unhandledMode;
    }
  }
}

// ── Live discovery over a started runtime ───────────────────────────────

/**
 * Discovery must restore model/effort in a finalizer even after caller timeout; never own the
 * caller's session lifecycle. Keep models with unobserved ladders listed with empty efforts. Write
 * Scient defaults too, because only Droid's applied answer establishes the actual level.
 */
export const discoverDroidModels = Effect.fn("DroidAcpSupport.discoverDroidModels")(function* (
  runtime: DroidModelEffortRuntime,
): Effect.fn.Return<ReadonlyArray<DroidDiscoveredModel>, EffectAcpErrors.AcpError> {
  const configOptions = yield* runtime.getConfigOptions;
  const initialModels = buildDroidModelsFromConfigOptions(configOptions);
  if (initialModels.length === 0) return [];
  const modelOption = findSelectOption(configOptions, isModelConfigOption);
  // Restore what was actually selected, not the first catalog entry.
  const originalSlug =
    typeof modelOption?.currentValue === "string" && modelOption.currentValue.trim() !== ""
      ? modelOption.currentValue.trim()
      : initialModels[0]!.slug;
  const effortSelector = { id: DROID_EFFORT_CONFIG_ID, category: "thought_level" };
  const originalEffort = findSelectDroidConfigOption(configOptions, effortSelector)?.currentValue;
  // Droid keeps the reasoning level across model switches, so the levels
  // written for the walked models would stay on the original model.
  const restore = Effect.gen(function* () {
    yield* runtime.setModel(originalSlug);
    if (typeof originalEffort !== "string") return;
    const effort = findSelectDroidConfigOption(yield* runtime.getConfigOptions, effortSelector);
    if (effort !== undefined && effort.currentValue !== originalEffort)
      yield* runtime.setConfigOption(effort.id, originalEffort);
  });

  const observeLadder = Effect.fn("DroidAcpSupport.observeLadder")(function* (
    model: DroidDiscoveredModel,
  ): Effect.fn.Return<DroidDiscoveredModel, EffectAcpErrors.AcpError> {
    // Droid's runtime-level setModel contract returns only after the
    // authoritative config_option_update reflects this selection.
    yield* runtime.setModel(model.slug);
    // A level Droid will not run at all is the thread's error to report.
    const replacedDefault =
      runtime.getReasoningMetadata?.(model.slug) == null
        ? undefined
        : yield* applyDroidModelAndEffort({
            runtime,
            requestedModel: undefined,
            requestedEffort: undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const snapshot = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions);
    const observed = snapshot.find((entry) => entry.slug === model.slug);
    return {
      slug: model.slug,
      name: model.name,
      capabilitiesObserved: observed?.capabilitiesObserved === true,
      currentEffortValue: observed?.currentEffortValue,
      efforts: observed?.efforts ?? [],
      providerCostLabel: model.providerCostLabel,
      replacedDefault,
    } satisfies DroidDiscoveredModel;
  });

  return yield* Effect.forEach(initialModels, observeLadder, { concurrency: 1 }).pipe(
    // Restore on every exit, including interruption. A failed restore fails discovery so callers
    // fall back to unknown ladders rather than reporting incorrect model/effort evidence.
    Effect.onExit(() => restore),
  );
});

// ── Composer capability mapping ─────────────────────────────────────────

/**
 * Converts a live effort ladder into composer capabilities. Droid has no
 * fast-mode or thinking toggles in its ACP surface; only the effort select.
 */
export function buildDroidCapabilitiesFromEfforts(
  efforts: ReadonlyArray<DroidDiscoveredEffortLevel>,
  metadata?: CustomModelReasoning | null,
  defaultReasoningLevel?: string,
  replacedDefault?: DroidReplacedDefault,
) {
  // The level Droid runs is the default; the one it replaced is not a choice.
  if (replacedDefault !== undefined) {
    efforts = efforts.filter((entry) => entry.value !== replacedDefault.configured);
    defaultReasoningLevel = replacedDefault.applied;
  }
  // A managed model without a configured effort keeps an empty strict
  // control: nothing to pick, and no saved level is dispatched for it.
  efforts =
    metadata === undefined
      ? efforts
      : droidConfiguresEffort(metadata)
        ? efforts.filter((entry) => droidMetadataAllowsEffort(metadata, entry.value))
        : [];
  if (metadata !== undefined) efforts = efforts.filter((entry) => entry.value !== "none");
  const selectedDefault = preferredReasoningLevel(
    efforts.map((entry) => entry.value),
    metadata?.defaultLevel,
    defaultReasoningLevel,
  );
  if (efforts.length === 0 && metadata === undefined) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        ...(metadata !== undefined
          ? {
              strictSelection: true,
              concreteReasoning: true,
              emptySelectionLabel: "Reasoning",
            }
          : {}),
        options: efforts.map((entry) => ({
          id: entry.value,
          label: entry.label,
          ...((metadata === undefined ? entry.isDefault : entry.value === selectedDefault)
            ? { isDefault: true }
            : {}),
        })),
      },
    ],
  });
}

/**
 * Whether the overlay gives Droid a `reasoningEffort` for a Scient model
 * (`buildDroidCustomModelsSettings`): only known reasoning with a concrete
 * level. Without one, Droid 0.213.0 and 0.230.0 advertise a generic ladder but
 * apply `none` for every choice and send no reasoning parameter.
 */
function droidConfiguresEffort(
  metadata: CustomModelReasoning | null,
): metadata is CustomModelReasoning {
  return (
    metadata?.status === "known" &&
    metadata.supported === true &&
    preferredReasoningLevel(metadata.levels) !== undefined
  );
}

function droidMetadataAllowsEffort(metadata: CustomModelReasoning, effort: string): boolean {
  // Keep stale known evidence and never translate Droid sentinels into API levels. Off means no
  // thinking only for adaptive Messages; effort APIs omit the parameter and use the model default
  // instead.
  if (effort === "off") return metadata.supported === true && metadata.mode === "adaptive";
  return metadata.supported !== false && metadata.levels.some((level) => level === effort);
}
