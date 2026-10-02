import {
  type DroidSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntimeType from "../acp/AcpSessionRuntime.ts";
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
  buildDroidCapabilitiesFromEfforts,
  buildDroidModelsFromConfigOptions,
  discoverDroidModels,
  droidAccountCapabilitiesFromInitializeResult,
  hasDroidApiKeyEnvironment,
  makeDroidAcpRuntime,
  makeDroidCredentialRedactor,
  resolveDroidCliBinaryPath,
  type DroidAccountCapabilities,
  type DroidAcpRuntimeFactory,
  type DroidAcpRuntime,
} from "../acp/DroidAcpSupport.ts";

const DROID_PRESENTATION = {
  displayName: "Droid",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
  // Droid's ACP surface has no conversation rewind.
  supportsConversationRollback: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const EMPTY_ACCOUNT_CAPABILITIES: DroidAccountCapabilities = {
  devicePairing: false,
  logout: false,
};

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS = 20_000;

export function buildInitialDroidProviderSnapshot(
  droidSettings: DroidSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = droidModelsFromSettings(droidSettings.customModels);

    if (!droidSettings.enabled) {
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Droid is disabled in Scient settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Droid CLI availability...",
      },
    });
  });
}

function droidModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES).map(
    (model) => (model.isCustom ? { ...model, capabilities: null } : model),
  );
}

/**
 * Builds the provider model list from one config-options snapshot, taken
 * when the session starts. Only the snapshot's currently selected model (the
 * default) carries an observed reasoning-effort
 * ladder (Droid refreshes ladders asynchronously after each selection);
 * other models stay listed with unknown (`null`) capabilities until they are
 * selected. Known-empty is reserved for a model that was selected and
 * genuinely exposed no reasoning-effort option.
 */
function buildDroidDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  getReasoningMetadata?: DroidAcpRuntime["getReasoningMetadata"],
  getDefaultReasoningLevel?: DroidAcpRuntime["getDefaultReasoningLevel"],
): ReadonlyArray<ServerProviderModel> {
  const discovered = buildDroidModelsFromConfigOptions(configOptions);
  if (discovered.length === 0) {
    return [];
  }
  return discovered.map((model): ServerProviderModel => {
    const metadata = getReasoningMetadata?.(model.slug);
    // A snapshot only ever carries the *selected* model's effort ladder.
    // Assigning it to every catalog entry would advertise invalid choices
    // for the other models (Droid validates effort per model), so unknown
    // ladders stay unknown until a selection refreshes them.
    return {
      slug: model.slug,
      name: model.name || model.slug,
      // Native discovery owns this row, including native and Scient-injected
      // BYOK models. isCustom is reserved for legacy config.customModels rows
      // that clients rebuild from settings, not Droid's `custom:` id syntax.
      isCustom: false,
      // At session start the selected model is Droid's own default (verified
      // against Droid 0.213.0 and 0.230.0), not the first one it lists. This
      // flag is Droid's whole part in the default: the shared automatic model
      // policy (`resolveAutomaticModel`) chooses the reported default.
      ...(model.capabilitiesObserved ? { isDefault: true } : {}),
      ...(model.providerCostLabel ? { providerCostLabel: model.providerCostLabel } : {}),
      capabilities:
        !model.capabilitiesObserved && metadata === undefined
          ? null
          : buildDroidCapabilitiesFromEfforts(
              model.efforts,
              metadata,
              getDefaultReasoningLevel?.(model.slug),
            ),
    };
  });
}

const DROID_ACP_MODEL_WALK_TIMEOUT_MS = 8_000;

/**
 * Classifies the Droid-specific unauthenticated signal surfaced by
 * `session/new`: JSON-RPC `-32000` with an "Authentication required"
 * message. Verified against a real `@factory/cli` binary by the probe test.
 * The code alone is NOT sufficient: `-32000` is the generic server-error
 * range, so a protocol defect or internal Factory error must fall through to
 * the generic startup-failure branch instead of masquerading as a sign-in
 * prompt. Message OR code+message keeps the match scoped while tolerating
 * minor wording drift around the required phrase.
 */
export function isDroidAuthenticationRequiredError(error: unknown): boolean {
  const candidates: Array<unknown> = [error];
  const directCause =
    error !== null && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  if (directCause !== undefined) candidates.push(directCause);
  const hasAuthMessage = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== "object") {
      return candidate instanceof Error && /authentication required/i.test(candidate.message);
    }
    const message =
      (candidate as { errorMessage?: unknown }).errorMessage ??
      (candidate instanceof Error ? candidate.message : undefined);
    return typeof message === "string" && /authentication required/i.test(message);
  };
  return candidates.some(hasAuthMessage);
}

const isAcpProcessExited = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpSpawnFailure = Schema.is(EffectAcpErrors.AcpSpawnError);
const isAcpRequestFailure = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * A short reason for a failed ACP startup, or none when the failure has no
 * safe wording. Never the process's own output: it can carry tokens. Droid's
 * answer to a startup request is quoted with the instance's credentials redacted.
 */
function describeDroidAcpStartupFailure(
  cause: Cause.Cause<unknown>,
  redactCredentials: (text: string) => string,
): string | undefined {
  // The probe reports a failed session start as a defect carrying its cause.
  const squashed = Cause.squash(cause);
  const failure = Cause.isCause(squashed) ? Cause.squash(squashed) : squashed;
  if (isAcpProcessExited(failure))
    return `Droid exited${failure.code === undefined ? "" : ` with code ${failure.code}`} before it was ready`;
  if (isAcpSpawnFailure(failure)) return "Droid could not be started";
  if (isAcpRequestFailure(failure)) {
    const answer = redactCredentials(failure.errorMessage.trim().split("\n", 1)[0] ?? "").trim();
    if (!answer) return undefined;
    return `Droid answered "${answer.length > 120 ? `${answer.slice(0, 119).trimEnd()}…` : answer}"`;
  }
  return undefined;
}

interface DroidAcpProbeOutcome {
  readonly modelConnections?: ServerProviderDraft["modelConnections"];
  readonly authentication: "authenticated" | "unauthenticated";
  /** The probe's Droid session, reused for skill discovery. */
  readonly sessionId?: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly accountCapabilities: DroidAccountCapabilities;
}

/**
 * The probe session requests the parameterized-model-picker capability so
 * agents that gate their per-model config surface behind it (Cursor, and the
 * mock agent used in tests) expose per-model option payloads.
 */
const DROID_PROBE_CLIENT_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

const makeDroidAcpProbeRuntime = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  makeAcpRuntime: DroidAcpRuntimeFactory,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeAcpRuntime({
      droidSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "scient-provider-probe", version: "0.0.0" },
      clientCapabilities: DROID_PROBE_CLIENT_CAPABILITIES,
      authenticationMode: "passive",
    });
  });

/**
 * Passive ACP probe over one disposable session: read the model
 * inventory from the session-setup config options, then walk every catalog
 * entry to observe its own reasoning-effort ladder (restoring the original
 * selection afterwards, inside `discoverDroidModels`). The walk is
 * best-effort and bounded: if it fails or times out, the snapshot inventory
 * stands with per-model ladders unknown rather than wrong — models never
 * disappear because a ladder could not be observed.
 */
const probeAndDiscoverDroidViaAcp = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  makeAcpRuntime: DroidAcpRuntimeFactory,
  cwd: string,
): Effect.Effect<
  DroidAcpProbeOutcome,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Runtime construction spawns the CLI, so it can fail with AcpError.
      // A spawn/construction failure is an environment defect, not an
      // authentication signal — route it to the defect channel so the probe
      // reports a generic error instead of "unauthenticated".
      const acp = yield* makeDroidAcpProbeRuntime(
        droidSettings,
        environment,
        makeAcpRuntime,
        cwd,
      ).pipe(Effect.catch((error) => Effect.die(error)));
      const initializeResult = yield* acp
        .initialize()
        .pipe(Effect.catch((error) => Effect.die(error)));
      const accountCapabilities = droidAccountCapabilitiesFromInitializeResult(initializeResult);
      // `null` = the agent refused startup with the scoped Droid
      // authentication signal (CLI not signed in). Any other failure is a
      // defect (dies), which the probe layer surfaces as a generic probe
      // error rather than a wrong auth verdict.
      type DroidProbeStart = AcpSessionRuntimeType.AcpSessionRuntimeStartResult | null;
      const startExit = yield* Effect.exit(acp.start());
      const started: DroidProbeStart = Exit.isSuccess(startExit)
        ? startExit.value
        : isDroidAuthenticationRequiredError(Cause.squash(startExit.cause))
          ? null
          : yield* Effect.die(startExit.cause);
      if (started === null) {
        return {
          authentication: "unauthenticated",
          models: [],
          accountCapabilities,
        } satisfies DroidAcpProbeOutcome;
      }

      const baseModels = buildDroidDiscoveredModelsFromConfigOptions(
        yield* acp.getConfigOptions,
        acp.getReasoningMetadata,
        acp.getDefaultReasoningLevel,
      );
      // Best-effort per-model ladder walk; never fails the probe. Success is
      // a `Some` of models; timeout, defect, or error all collapse to `None`.
      const walkedModels = yield* discoverDroidModels(acp).pipe(
        Effect.timeoutOption(DROID_ACP_MODEL_WALK_TIMEOUT_MS),
        Effect.catch(() => Effect.succeedNone),
      );
      if (Option.isNone(walkedModels)) {
        yield* Effect.logWarning(
          "Droid per-model effort discovery was unavailable; advertising unobserved ladders as unknown.",
        );
        return {
          authentication: "authenticated",
          sessionId: started.sessionId,
          models: baseModels,
          modelConnections: acp.assessModelConnections?.(baseModels),
          accountCapabilities,
        } satisfies DroidAcpProbeOutcome;
      }

      const walkedBySlug = new Map(walkedModels.value.map((model) => [model.slug, model] as const));
      return {
        authentication: "authenticated",
        sessionId: started.sessionId,
        accountCapabilities,
        modelConnections: acp.assessModelConnections?.(baseModels),
        models: baseModels.map((model) => {
          const walked = walkedBySlug.get(model.slug);
          const metadata = acp.getReasoningMetadata?.(model.slug);
          return {
            ...model,
            capabilities:
              (walked === undefined || !walked.capabilitiesObserved) && metadata === undefined
                ? null
                : buildDroidCapabilitiesFromEfforts(
                    walked?.efforts ?? [],
                    metadata,
                    acp.getDefaultReasoningLevel?.(model.slug),
                    walked?.replacedDefault,
                  ),
          };
        }),
      } satisfies DroidAcpProbeOutcome;
    }),
  );

const runDroidVersionCommand = (droidSettings: DroidSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = resolveDroidCliBinaryPath(droidSettings.binaryPath);
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

/**
 * `droid --version` alone: no session, no network. None when the command
 * failed, timed out or exited non-zero; periodic status checks use it.
 */
export const probeDroidCliVersion = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<Option.Option<string | null>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runDroidVersionCommand(droidSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.map((output) =>
      Option.isSome(output) && output.value.code === 0
        ? Option.some(parseGenericCliVersion(`${output.value.stdout}\n${output.value.stderr}`))
        : Option.none(),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

export interface DroidProviderStatusResult {
  readonly snapshot: ServerProviderDraft;
  readonly accountCapabilities: DroidAccountCapabilities;
  /** The probe's Droid session when one was started; skill discovery reuses it. */
  readonly sessionId?: string;
}

const droidProviderStatusResult = (
  snapshot: ServerProviderDraft,
  accountCapabilities: DroidAccountCapabilities = EMPTY_ACCOUNT_CAPABILITIES,
  sessionId?: string,
): DroidProviderStatusResult => ({
  snapshot,
  accountCapabilities,
  ...(sessionId !== undefined ? { sessionId } : {}),
});

export const checkDroidProviderStatusWithCapabilities = Effect.fn(
  "checkDroidProviderStatusWithCapabilities",
)(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeAcpRuntime: DroidAcpRuntimeFactory = makeDroidAcpRuntime,
  cwd: string = process.cwd(),
  /** The instance's environment values marked sensitive. */
  sensitiveEnvironmentValues: ReadonlyArray<string> = [],
): Effect.fn.Return<
  DroidProviderStatusResult,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = droidModelsFromSettings(droidSettings.customModels);
  const authenticatedAccount = hasDroidApiKeyEnvironment(environment)
    ? ({ status: "authenticated", type: "apiKey", label: "Factory API Key" } as const)
    : ({ status: "authenticated", type: "subscription", label: "Factory account" } as const);

  if (!droidSettings.enabled) {
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Droid is disabled in Scient settings.",
        },
      }),
    );
  }

  const versionResult = yield* runDroidVersionCommand(droidSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Droid CLI health check failed.", {
      errorTag: error._tag,
    });
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Droid CLI (`droid`) is not installed or not on PATH."
            : "Failed to execute Droid CLI health check.",
        },
      }),
    );
  }

  if (Option.isNone(versionResult.success)) {
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Droid CLI is installed but timed out while running `droid --version`.",
        },
      }),
    );
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Droid CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Droid CLI is installed but failed to run.",
        },
      }),
    );
  }

  const probeExit = yield* probeAndDiscoverDroidViaAcp(
    droidSettings,
    environment,
    makeAcpRuntime,
    cwd,
  ).pipe(Effect.timeoutOption(DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Droid ACP auth/model probe failed", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    const reason = describeDroidAcpStartupFailure(
      probeExit.cause,
      makeDroidCredentialRedactor({ environment, sensitiveValues: sensitiveEnvironmentValues }),
    );
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: reason
            ? `Droid CLI is installed but ACP startup failed: ${reason}.`
            : "Droid CLI is installed but ACP startup failed. Check server logs for details.",
        },
      }),
    );
  }
  if (Option.isNone(probeExit.value)) {
    yield* Effect.logWarning(
      `Droid ACP probe timed out after ${DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `Droid CLI is installed but ACP startup timed out after ${DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS}ms.`,
        },
      }),
    );
  }

  const probeOutcome = probeExit.value.value;
  if (probeOutcome.authentication === "unauthenticated") {
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unauthenticated", required: true },
          message: "Droid is installed. Sign in with your existing Factory subscription.",
        },
      }),
      probeOutcome.accountCapabilities,
    );
  }
  if (probeOutcome.models.length === 0) {
    return droidProviderStatusResult(
      buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: droidSettings.enabled,
        checkedAt,
        models: fallbackModels,
        modelConnections: probeOutcome.modelConnections,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: authenticatedAccount,
          message: "Droid CLI is authenticated but did not report any models.",
        },
      }),
      probeOutcome.accountCapabilities,
      probeOutcome.sessionId,
    );
  }

  return droidProviderStatusResult(
    buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: probeOutcome.models,
      modelConnections: probeOutcome.modelConnections,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: authenticatedAccount,
      },
    }),
    probeOutcome.accountCapabilities,
    probeOutcome.sessionId,
  );
});

export const checkDroidProviderStatus = Effect.fn("checkDroidProviderStatus")(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  return (yield* checkDroidProviderStatusWithCapabilities(droidSettings, environment)).snapshot;
});

export const enrichDroidSnapshot = (input: {
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
      Effect.logWarning("Droid version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
