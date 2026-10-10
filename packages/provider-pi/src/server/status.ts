/**
 * PiProvider — snapshot/probe layer for the Pi coding agent.
 *
 * Health is probed with `pi --version`. Models, the user's default model, and
 * the user's commands (extension slash commands, prompt templates, skills)
 * are discovered through a short-lived ephemeral RPC session
 * (`pi --mode rpc --no-session`), so everything the user configured in
 * `~/.pi/agent` — models.json entries, prompt templates and skills —
 * shows up in T3 without any hardcoded catalog. Unattended discovery never
 * executes user extensions; native interactive sessions retain them.
 */
import {
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { PiSettings } from "../settings.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import {
  makePiRpcConnection,
  PiRpcError,
  PiRpcTimeoutError,
  piRecordField as recordField,
  piRecordString as recordString,
} from "./rpc.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { PiRpcClient, PiRpcError as PiClientError, PiRpcSpawnOptions } from "./rpcClient.ts";
import { encodePiModelSlug } from "./model.ts";
import { PI_DISCOVERY_LAUNCH_POLICY } from "./discoveryPolicy.ts";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./thinkingCapabilities.ts";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "./commands.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // The adapter reports context usage from Pi's streaming usage while a
  // turn runs, so clients can reserve the meter before the first settle.
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 15_000;
/**
 * get_entries arrived in 0.80.3 and agent_settled landed in source at 0.80.4.
 * Version 0.80.5 was the first published package containing both hooks. T3
 * needs them for rollback boundaries and reliable turn terminalization.
 */
export const MINIMUM_PI_VERSION = "0.80.5";

/** Deferring to the user's own settings.json default model. */
const PI_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
  readonly modelConnections?: ServerProvider["modelConnections"];
}

type PiDiscoveryClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<
  PiRpcClient,
  PiClientError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
>;

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [PI_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  defaultThinkingLevel: unknown,
  providerLabel?: (provider: string) => string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) continue;
    const slug = encodePiModelSlug(provider, id);
    if (slug === undefined) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      ...(providerLabel === undefined ? {} : { subProvider: providerLabel(provider) ?? provider }),
      capabilities: thinkingCapabilitiesForPiModel(model, defaultThinkingLevel),
    });
  }
  return parsed;
}

const makePiDiscoveryConnection = Effect.fnUntraced(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const launch = buildPiRpcLaunch({
    launchArgs,
    environment,
    mcpSession: undefined,
    extensionPath: undefined,
    // SCIENT-FORK:START — workspace inventory never executes user extension code.
    ...PI_DISCOVERY_LAUNCH_POLICY,
    // SCIENT-FORK:END
  });
  const connection = yield* makePiRpcConnection({
    command: piSettings.binaryPath || "pi",
    args: launch.args,
    cwd,
    env: launch.env,
  });
  yield* Stream.fromQueue(connection.events).pipe(
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );
  return connection;
});

const discoverPiViaRpc = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd: string | undefined,
  makeDiscoveryClient: PiDiscoveryClientFactory | undefined,
) =>
  Effect.gen(function* () {
    const launch = buildPiRpcLaunch({
      launchArgs,
      environment,
      mcpSession: undefined,
      extensionPath: undefined,
      // SCIENT-FORK:START — inventory must not execute workspace or profile extensions.
      ...PI_DISCOVERY_LAUNCH_POLICY,
      // SCIENT-FORK:END
    });
    if (makeDiscoveryClient !== undefined) {
      const client = yield* makeDiscoveryClient({
        command: piSettings.binaryPath || "pi",
        // The typed client owns the RPC mode prefix.
        args: launch.args.slice(2),
        ...(cwd === undefined ? {} : { cwd }),
        env: launch.env,
      });
      yield* client.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      const state = yield* client.getState();
      const inventory = yield* client.getAvailableModels();
      const commands = yield* client.getCommands();
      const models = parseDiscoveredModels(
        inventory,
        state.thinkingLevel,
        client.modelProviderLabel,
      );
      const discovered = parsePiDiscoveredCommands(commands);
      return {
        models,
        slashCommands: withPiBuiltinSlashCommands(discovered.slashCommands),
        skills: discovered.skills,
        authenticated: models.length > 0,
        ...(client.assessModelConnections === undefined
          ? {}
          : {
              modelConnections: client.assessModelConnections(inventory.models),
            }),
      } satisfies PiDiscovery;
    }
    const connection = yield* makePiRpcConnection({
      command: piSettings.binaryPath || "pi",
      args: launch.args,
      cwd,
      env: launch.env,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const stateData = yield* connection.request({ type: "get_state" });
    const modelsData = yield* connection.request({ type: "get_available_models" });
    const commandsData = yield* connection
      .request({ type: "get_commands" })
      .pipe(Effect.orElseSucceed(() => undefined));
    const discoveredModels = parseDiscoveredModels(
      modelsData,
      recordString(stateData, "thinkingLevel"),
    );
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return {
      models: discoveredModels,
      slashCommands: withPiBuiltinSlashCommands(slashCommands),
      skills,
      authenticated: discoveredModels.length > 0,
    } satisfies PiDiscovery;
  }).pipe(Effect.scoped);

/** Probe the full command catalog Pi exposes in a workspace without changing machine health. */
export const discoverPiCommandsForCwd = Effect.fn("discoverPiCommandsForCwd")(
  function* (
    piSettings: PiSettings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    makeDiscoveryClient?: PiDiscoveryClientFactory,
  ) {
    const launchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
    if (!launchArgs.ok) {
      return yield* new PiRpcError({ operation: "launch", detail: launchArgs.message });
    }
    if (makeDiscoveryClient !== undefined) {
      const launch = buildPiRpcLaunch({
        launchArgs: launchArgs.args,
        environment,
        mcpSession: undefined,
        extensionPath: undefined,
        ...PI_DISCOVERY_LAUNCH_POLICY,
      });
      const client = yield* makeDiscoveryClient({
        command: piSettings.binaryPath || "pi",
        args: launch.args.slice(2),
        cwd,
        env: launch.env,
      });
      yield* client.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      const commands = parsePiDiscoveredCommands(yield* client.getCommands());
      return { ...commands, slashCommands: withPiBuiltinSlashCommands(commands.slashCommands) };
    }
    const connection = yield* makePiDiscoveryConnection(
      piSettings,
      environment,
      launchArgs.args,
      cwd,
    );
    // A failed read must not replace a previously usable workspace catalog with an empty one.
    const commandsData = yield* connection.request({ type: "get_commands" });
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return { slashCommands: withPiBuiltinSlashCommands(slashCommands), skills };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: PI_RPC_DISCOVERY_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(
        new PiRpcTimeoutError({ operation: "discovery", timeoutMs: PI_RPC_DISCOVERY_TIMEOUT_MS }),
      ),
  }),
);

const runPiVersionCommand = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
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

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in Scient settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  makeDiscoveryClient?: PiDiscoveryClientFactory,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in Scient settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install with `npm install -g @earendil-works/pi-coding-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Scient could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ${version} is unsupported. Update to Pi ${MINIMUM_PI_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(
    piSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
    makeDiscoveryClient,
  ).pipe(Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but Scient could not refresh its models and commands. The live session will retry startup.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but model and command discovery needs interactive input. The live session will handle it.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(piSettings.customModels, discovery.models);
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    ...(discovery.modelConnections === undefined
      ? {}
      : { modelConnections: discovery.modelConnections }),
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(discovery.authenticated
        ? {}
        : {
            message:
              "Pi has no usable models. Run `pi` in a terminal and use /login, or configure an API key in ~/.pi/agent.",
          }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
