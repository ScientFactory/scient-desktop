import {
  type DroidSettings,
  type RuntimeMode,
  type ServerProviderModel,
  type ModelConnectionReadiness,
} from "@t3tools/contracts";
import { createModelCapabilities, preferredReasoningLevel } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { CustomModelReasoning } from "../../customModelCapabilities.ts";

/**
 * Droid ACP support — helpers for the Factory Droid CLI's standard-ACP
 * surface (`droid exec --output-format acp`).
 *
 * Protocol facts encoded here were verified against a real `@factory/cli`
 * 0.200.0 binary by `DroidAcpCliProbe.test.ts`; anything version-sensitive
 * is asserted there so drift surfaces as a failing probe instead of silent
 * misconfiguration.
 *
 * Verified behaviors this module relies on:
 * - `droid exec` ignores `-m`/`-r` in ACP mode; model/effort/mode selection
 *   must go through `session/set_config_option`.
 * - The model inventory lives in the `model` select option (`category:
 *   "model"`); reasoning ladders live in `reasoning_effort` (`category:
 *   "thought_level"`) and change with the selected model.
 * - Model writes use `set_config_option` requests, confirmed through
 *   `config_option_update`. Droid 0.202 ignores notifications; older
 *   0.200 builds could apply a request without sending its response.
 * - Modes are exposed both as a `modes` block and an `autonomy_level`
 *   select option with ids `normal | spec | auto-low | auto-medium |
 *   auto-high`.
 */

/** Compatibility marker advertised by genuine Droid ACP agents. */
export const DROID_AGENT_INFO_NAME = "@factory/cli";

export const DROID_AUTH_METHOD_API_KEY = "factory-api-key";
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

export const DROID_EFFORT_CONFIG_ID = "reasoning_effort";
const DROID_AUTONOMY_CONFIG_ID = "autonomy_level";

/** Env vars whose presence selects key-based auth for probes and sessions. */
const DROID_API_KEY_ENV_KEYS: ReadonlyArray<string> = ["FACTORY_API_KEY"];

type DroidAcpRuntimeDroidSettings = Pick<DroidSettings, "binaryPath">;

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
  /** Per-process Droid settings overlay. The path may contain secrets; never log it with contents. */
  readonly runtimeSettingsPath?: string;
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
  /** False for a pending next-turn generation as well as a retired process. */
  readonly isConfigurationCurrent?: () => boolean;
  readonly isConfigurationRetired?: () => boolean;
  readonly checkConfiguration?: () => Effect.Effect<void, EffectAcpErrors.AcpError>;
};
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
    ...(environment ? { env: environment } : {}),
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
export const DROID_HEADLESS_AUTH_META = { headless: true } as const;

export const makeDroidAcpRuntime = (
  input: DroidAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { authenticationMode = "active", runtimeSettingsPath, ...runtimeInput } = input;
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
        // Droid 0.202 ignores request-shaped notifications. Send a real request
        // and wait for its model/effort snapshot before applying effort or prompting.
        // This also tolerates older builds that publish the snapshot without a response.
        configOptionTransport: (configId) =>
          ["model", "reasoning_effort"].includes(configId.trim().toLowerCase())
            ? "request-confirmed"
            : "request",
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
}

/**
 * Extracts a compact `Nx`-style cost label from a Droid model option's
 * `description`. The real CLI annotates each model with its Factory token
 * rate (e.g. "0.5x Factory token rate", "12x Factory token rate"); only a
 * leading multiplier is treated as a cost label so prose descriptions
 * degrade to no badge rather than a wrong number.
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
 * Builds the live model inventory from one config-options snapshot. The
 * snapshot's effort ladder describes only the *currently selected* model
 * (`modelOption.currentValue`), so it is attached to that entry alone;
 * every other model stays with an empty ladder until a selection refreshes
 * it — Droid validates efforts per model, so copying the ladder to all
 * entries would advertise invalid choices.
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
  return findSelectOption(
    configOptions,
    (option) =>
      option.id.trim().toLowerCase() === DROID_AUTONOMY_CONFIG_ID ||
      option.category?.trim().toLowerCase() === "mode",
  );
}

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
  return findSelectOption(
    configOptions,
    (option) =>
      (optionId !== undefined && option.id.trim().toLowerCase() === optionId) ||
      (categoryId !== undefined && option.category?.trim().toLowerCase() === categoryId),
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
 * Applies model first, then reasoning effort: Droid validates effort values
 * against the selected model, so the order is a protocol requirement, not a
 * preference. The effort is validated against the live ladder before writing
 * so a stale picker choice fails with an explicit error instead of an opaque
 * agent-side one. Managed models also validate inherited effort against
 * provider evidence when no explicit effort is requested.
 */
const configureDroidModelAndEffort = (input: {
  readonly runtime: DroidModelEffortRuntime;
  readonly requestedModel: string | undefined;
  readonly requestedEffort: string | undefined;
  readonly validationOnly?: boolean;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    let requestedEffort = input.requestedEffort;
    if (input.requestedModel !== undefined) {
      yield* input.runtime.setModel(input.requestedModel);
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
    const preference =
      typeof modelOption?.currentValue === "string"
        ? input.runtime.getDefaultReasoningLevel?.(modelOption.currentValue)
        : undefined;
    if (
      !input.validationOnly &&
      requestedEffort === undefined &&
      preference !== undefined &&
      metadata?.status === "known" &&
      metadata.supported &&
      effortOption?.type === "select"
    ) {
      const supported = effortOption.options
        .flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
        )
        .filter((level) => droidMetadataAllowsEffort(metadata, level));
      requestedEffort = preferredReasoningLevel(supported, metadata.defaultLevel, preference);
    }
    const effectiveEffort =
      requestedEffort ??
      (typeof effortOption?.currentValue === "string" ? effortOption.currentValue : undefined);
    // The managed overlay disables thinking for known nonreasoning models.
    // Its inherited ACP sentinel is not an explicit API effort selection.
    if (
      metadata?.status === "known" &&
      metadata.supported === false &&
      requestedEffort === undefined
    )
      return;
    if (
      metadata?.status === "known" &&
      effectiveEffort !== undefined &&
      !droidMetadataAllowsEffort(metadata, effectiveEffort)
    ) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage:
          metadata.supported === false
            ? "The selected model does not support reasoning effort. Clear the explicit reasoning effort before sending."
            : `Droid runtime reasoning effort "${effectiveEffort}" conflicts with the selected model's provider metadata. Select a supported effort before sending.`,
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
    yield* input.runtime.setConfigOption(effortOption.id, requestedEffort);
    if (metadata !== undefined) {
      // Detect a runtime-reported clamp. This is ACP state, not proof that
      // the upstream API honored reasoning (ACP can acknowledge optimistically).
      const after = findSelectDroidConfigOption(yield* input.runtime.getConfigOptions, {
        id: effortOption.id,
      });
      if (after?.currentValue !== requestedEffort) {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Droid did not retain the requested reasoning effort "${requestedEffort}". The runtime reported "${after?.currentValue ?? "unknown"}"; the prompt was not sent.`,
        });
      }
    }
  });

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
  });

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

interface DiscoveryRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setModel: AcpSessionRuntime.AcpSessionRuntime["Service"]["setModel"];
}

/**
 * Discovers Droid models and per-model reasoning-effort ladders over a
 * started runtime. The caller owns the runtime lifecycle and any overall
 * timeout; discovery never starts or stops sessions itself.
 *
 * Each model is briefly selected so its own ladder can be read, then the
 * originally selected model is restored. Restoration runs in an `ensuring`
 * finalizer, so even a caller timeout (which interrupts this effect) cannot
 * leave an unrelated model selected. A model whose ladder cannot be observed
 * stays listed with empty efforts — a missing ladder must not hide an
 * otherwise usable model.
 */
export const discoverDroidModels = (
  runtime: DiscoveryRuntime,
): Effect.Effect<ReadonlyArray<DroidDiscoveredModel>, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const configOptions = yield* runtime.getConfigOptions;
    const initialModels = buildDroidModelsFromConfigOptions(configOptions);
    if (initialModels.length === 0) return [];
    const modelOption = findSelectOption(configOptions, isModelConfigOption);
    // Restore what was actually selected, not the first catalog entry.
    const originalSlug =
      typeof modelOption?.currentValue === "string" && modelOption.currentValue.trim() !== ""
        ? modelOption.currentValue.trim()
        : initialModels[0]!.slug;

    const observeLadder = (
      model: DroidDiscoveredModel,
    ): Effect.Effect<DroidDiscoveredModel, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        // Droid's runtime-level setModel contract returns only after the
        // authoritative config_option_update reflects this selection.
        yield* runtime.setModel(model.slug);
        const snapshot = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions);
        const observed = snapshot.find((entry) => entry.slug === model.slug);
        return {
          slug: model.slug,
          name: model.name,
          capabilitiesObserved: observed?.capabilitiesObserved === true,
          currentEffortValue: observed?.currentEffortValue,
          efforts: observed?.efforts ?? [],
          providerCostLabel: model.providerCostLabel,
        } satisfies DroidDiscoveredModel;
      });

    return yield* Effect.forEach(initialModels, observeLadder, { concurrency: 1 }).pipe(
      // Restoration runs on every exit path — including a caller timeout that
      // interrupts this effect — so the walk cannot leave an unrelated model
      // selected. A failing restore fails the walk; the probe then degrades
      // to the snapshot inventory with unknown ladders rather than wrong ones.
      Effect.onExit(() => runtime.setModel(originalSlug)),
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
) {
  efforts =
    metadata?.status === "known"
      ? efforts.filter((entry) => droidMetadataAllowsEffort(metadata, entry.value))
      : efforts;
  if (metadata !== undefined)
    efforts = efforts.filter((entry) => !["off", "none"].includes(entry.value));
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

function droidMetadataAllowsEffort(metadata: CustomModelReasoning, effort: string): boolean {
  // Stale known evidence remains evidence. Never translate Droid sentinels
  // (such as `none`) into API levels or manufacture an off capability.
  return metadata.supported !== false && metadata.levels.some((level) => level === effort);
}
