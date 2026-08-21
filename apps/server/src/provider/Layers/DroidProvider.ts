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
  isDroidCustomModelId,
  makeDroidAcpRuntime,
  resolveDroidCliBinaryPath,
} from "../acp/DroidAcpSupport.ts";

const DROID_PRESENTATION = {
  displayName: "Droid",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

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
 * Builds the provider model list from one config-options snapshot. Only the
 * snapshot's currently selected model carries an observed reasoning-effort
 * ladder (Droid refreshes ladders asynchronously after each selection);
 * other models stay listed with unknown (`null`) capabilities until they are
 * selected. Known-empty is reserved for a model that was selected and
 * genuinely exposed no reasoning-effort option.
 */
function buildDroidDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const discovered = buildDroidModelsFromConfigOptions(configOptions);
  if (discovered.length === 0) {
    return [];
  }
  return discovered.map((model): ServerProviderModel => {
    // A snapshot only ever carries the *selected* model's effort ladder.
    // Assigning it to every catalog entry would advertise invalid choices
    // for the other models (Droid validates effort per model), so unknown
    // ladders stay unknown until a selection refreshes them.
    return {
      slug: model.slug,
      name: model.name || model.slug,
      isCustom: isDroidCustomModelId(model.slug),
      ...(model.providerCostLabel ? { providerCostLabel: model.providerCostLabel } : {}),
      capabilities: !model.capabilitiesObserved
        ? null
        : model.efforts.length > 0
          ? buildDroidCapabilitiesFromEfforts(model.efforts)
          : EMPTY_CAPABILITIES,
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

interface DroidAcpProbeOutcome {
  readonly authenticated: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
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

const makeDroidAcpProbeRuntime = (droidSettings: DroidSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeDroidAcpRuntime({
      droidSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "scient-provider-probe", version: "0.0.0" },
      clientCapabilities: DROID_PROBE_CLIENT_CAPABILITIES,
    });
  });

/**
 * Full ACP probe over one disposable session: authenticate, read the model
 * inventory from the session-setup config options, then walk every catalog
 * entry to observe its own reasoning-effort ladder (restoring the original
 * selection afterwards, inside `discoverDroidModels`). The walk is
 * best-effort and bounded: if it fails or times out, the snapshot inventory
 * stands with per-model ladders unknown rather than wrong — models never
 * disappear because a ladder could not be observed.
 */
const authenticateAndDiscoverDroidViaAcp = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
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
      const acp = yield* makeDroidAcpProbeRuntime(droidSettings, environment).pipe(
        Effect.catch((error) => Effect.die(error)),
      );
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
        return { authenticated: false, models: [] } satisfies DroidAcpProbeOutcome;
      }

      const baseModels = buildDroidDiscoveredModelsFromConfigOptions(
        started.sessionSetupResult.configOptions,
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
        return { authenticated: true, models: baseModels } satisfies DroidAcpProbeOutcome;
      }

      const walkedBySlug = new Map(walkedModels.value.map((model) => [model.slug, model] as const));
      return {
        authenticated: true,
        models: baseModels.map((model) => {
          const walked = walkedBySlug.get(model.slug);
          return {
            ...model,
            capabilities:
              walked === undefined || !walked.capabilitiesObserved
                ? null
                : walked.efforts.length > 0
                  ? buildDroidCapabilitiesFromEfforts(walked.efforts)
                  : EMPTY_CAPABILITIES,
          };
        }),
      } satisfies DroidAcpProbeOutcome;
    }),
  );

const runDroidVersionCommand = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
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

export const checkDroidProviderStatus = Effect.fn("checkDroidProviderStatus")(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = droidModelsFromSettings(droidSettings.customModels);

  if (!droidSettings.enabled) {
    return buildServerProvider({
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
    });
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
    return buildServerProvider({
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
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
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
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Droid CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
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
    });
  }

  const probeExit = yield* authenticateAndDiscoverDroidViaAcp(droidSettings, environment).pipe(
    Effect.timeoutOption(DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Droid ACP auth/model probe failed", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Droid CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(probeExit.value)) {
    yield* Effect.logWarning(
      `Droid ACP probe timed out after ${DROID_ACP_AUTH_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
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
    });
  }

  const probeOutcome = probeExit.value.value;
  if (!probeOutcome.authenticated) {
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated", required: true },
        message:
          "Droid CLI is installed but not signed in. Run `droid` once in a terminal to pair this device, or set FACTORY_API_KEY.",
      },
    });
  }
  if (probeOutcome.models.length === 0) {
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "authenticated" },
        message: "Droid CLI is authenticated but did not report any models.",
      },
    });
  }

  return buildServerProvider({
    presentation: DROID_PRESENTATION,
    enabled: droidSettings.enabled,
    checkedAt,
    models: probeOutcome.models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
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
