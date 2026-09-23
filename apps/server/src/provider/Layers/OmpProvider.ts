import { OmpSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { OmpRpcCommandError, OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { compileOmpCommandCatalog } from "../omp/OmpCommandPolicy.ts";
import { ompModelToServerModel } from "../omp/OmpModel.ts";
import {
  OMP_ISOLATED_ARGS,
  OMP_MINIMUM_VERSION,
  makeOmpRpcProcess,
  ompUserDetail,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
import {
  isCommandMissingCause,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  reportsContextWindow: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access"],
  supportsConversationRollback: false,
  requiresNewThreadForModelChange: false,
} as const;

export type OmpProcessFactory = (
  options: OmpRpcProcessOptions,
) => Effect.Effect<
  OmpRpcProcess,
  OmpRpcError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
>;

const isProtocolError = Schema.is(OmpRpcProtocolError);
const isCommandError = Schema.is(OmpRpcCommandError);

const checkedAt = Effect.map(DateTime.now, DateTime.formatIso);

const discoveryMessage = (error: unknown): string => {
  if (isProtocolError(error) || isCommandError(error)) return ompUserDetail(error.detail);
  return `Oh My Pi could not be checked. Confirm the executable path and that version ${OMP_MINIMUM_VERSION} or newer is installed.`;
};

export const makePendingOmpProvider = (settings: OmpSettings): Effect.Effect<ServerProviderDraft> =>
  checkedAt.pipe(
    Effect.map((at) =>
      buildServerProvider({
        presentation: PRESENTATION,
        enabled: settings.enabled,
        checkedAt: at,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? "Oh My Pi has not been checked in this session yet."
            : "Oh My Pi is disabled in Scient settings.",
        },
      }),
    ),
  );

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeProcess: OmpProcessFactory = makeOmpRpcProcess,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft & { readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand> },
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const at = yield* checkedAt;
  if (!settings.enabled) return yield* makePendingOmpProvider(settings);
  const discovery = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeProcess({
        command: settings.binaryPath,
        env: environment,
        extraArgs: OMP_ISOLATED_ARGS,
        ...(cwd === undefined ? {} : { cwd }),
      });
      const [models, commands] = yield* Effect.all([client.getModels(), client.getCommands()], {
        concurrency: "unbounded",
      });
      return { version: client.version, models: models.models, commands: commands.commands };
    }),
  ).pipe(Effect.exit);
  if (discovery._tag === "Failure") {
    const error = Cause.squash(discovery.cause);
    const commandMissing =
      isCommandMissingCause(error) ||
      (isProtocolError(error) && isCommandMissingCause(error.cause));
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt: at,
      models: [],
      probe: {
        installed: !commandMissing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: discoveryMessage(error),
      },
    });
  }
  const models = discovery.value.models.flatMap((model) => {
    const mapped = ompModelToServerModel(model);
    return mapped ? [mapped] : [];
  });
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt: at,
    models,
    slashCommands: compileOmpCommandCatalog(discovery.value.commands).advertised,
    probe: {
      installed: true,
      version: discovery.value.version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      message:
        models.length > 0
          ? "Oh My Pi is available. Model sign-in stays in Oh My Pi; Scient does not ask for it."
          : "Oh My Pi started, but it did not report any models.",
    },
  });
});
