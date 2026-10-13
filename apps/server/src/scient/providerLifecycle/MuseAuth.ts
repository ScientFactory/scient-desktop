import {
  ProviderDriverKind,
  ProviderSetupError,
  TextGenerationError,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { MUSE_MINIMUM_VERSION, compareManagedMuseVersions } from "@scientfactory/provider-runtime";

import {
  findTerminalAuthorizationUrl,
  normalizeTerminalOutput,
} from "./ProviderConnectionActions.ts";
import { ProviderLifecycleCoordinator } from "./ProviderLifecycleCoordinator.ts";
import {
  makeLocalOwnedProcessCleanup,
  LOCAL_OWNED_PROCESS_KILL_OPTIONS,
} from "../execution/LocalOwnedProcess.ts";

const MUSE_DRIVER = ProviderDriverKind.make("muse");
const MAX_OUTPUT = 128 * 1024;

/** POSIX keys are case-sensitive; Windows' native environment is not. */
export function usesMuseApiKey(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  // Node forwards the first lexically sorted spelling of a duplicate Windows key.
  const name =
    platform === "win32"
      ? Object.keys(environment)
          .sort()
          .find((key) => key.toUpperCase() === "META_API_KEY")
      : "META_API_KEY";
  return name !== undefined && Boolean(environment[name]?.trim());
}

export function canAuthenticateMuse(
  snapshot: Pick<ServerProvider, "enabled" | "installed" | "version">,
  usesKey: boolean,
) {
  return (
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.version !== null &&
    (compareManagedMuseVersions(MUSE_MINIMUM_VERSION, snapshot.version) ?? -1) >= 0 &&
    !usesKey
  );
}

/** Only Meta's device approval page is an authorization target, never arbitrary CLI output. */
export function readMuseDeviceInteraction(output: string) {
  const url = findTerminalAuthorizationUrl(
    output,
    (candidate) =>
      candidate.hostname === "auth.meta.com" &&
      candidate.port === "" &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.pathname.startsWith("/"),
  );
  const code =
    /(?:Confirm this code matches|Enter this code|Your code|Code)\s*:?\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)(?=\s)/iu.exec(
      normalizeTerminalOutput(output),
    )?.[1];
  return url && code ? { url, userCode: code } : undefined;
}

/** The native tool owns login, key persistence and logout. Passive auth remains unknown. */
export const makeMuseAuth = Effect.fn("MuseAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly snapshot: ManagedServerProvider;
  readonly cwd: string;
  readonly onChanged: Effect.Effect<void, ProviderSetupError>;
  /** Closes this instance's native sessions; any failure keeps the account locked. */
  readonly beforeChange?: Effect.Effect<void, ProviderSetupError>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const coordinator = yield* ProviderLifecycleCoordinator;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const blocked = yield* Ref.make(false);
  const usesKey = usesMuseApiKey(options.environment, platform);
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const environment = { ...options.environment, MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" };

  const reserve = Effect.fnUntraced(function* (operationId: string) {
    if (yield* Ref.get(blocked))
      return yield* failure(
        "start",
        "Muse process shutdown failed. Restart this server before changing its account or runtime.",
      );
    const reserved = yield* coordinator.reserve({
      instanceId: options.instanceId,
      provider: MUSE_DRIVER,
      exclusiveProvider: true,
      reservation: { operationId, kind: "connection" },
    });
    if (!reserved) return yield* failure("start", "Another Muse lifecycle operation is running.");
    yield* Effect.addFinalizer(() =>
      Ref.get(blocked).pipe(
        Effect.flatMap((failed) =>
          failed ? Effect.void : coordinator.release({ operationId }).pipe(Effect.asVoid),
        ),
      ),
    );
  }, Effect.uninterruptible);

  const run = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    output: (text: string) => Effect.Effect<void> = () => Effect.void,
    input?: string,
  ) {
    const operation = args[0] === "logout" ? "logout" : "start";
    const unavailable = () => failure(operation, "Muse could not complete the account operation.");
    const resolved = yield* resolveSpawnCommand(options.binaryPath, args, {
      env: environment,
      extendEnv: false,
    }).pipe(Effect.mapError(unavailable));
    const child = yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          cwd: options.cwd,
          env: environment,
          extendEnv: false,
          shell: resolved.shell,
          detached: platform !== "win32",
          ...LOCAL_OWNED_PROCESS_KILL_OPTIONS,
          ...(input === undefined
            ? {}
            : { stdin: Stream.succeed(new TextEncoder().encode(`${input}\n`)) }),
        }),
      )
      .pipe(Effect.mapError(unavailable));
    const ownedClose = yield* makeLocalOwnedProcessCleanup(child, platform);
    const close = ownedClose.pipe(
      Effect.tapError(() => Ref.set(blocked, true)),
      Effect.mapError(() =>
        failure(
          operation,
          "Muse's process did not exit. Its saved credentials may have changed; restart this server before retrying.",
        ),
      ),
    );
    // Record shutdown failure before the enclosing account reservation finalizer runs.
    yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
    const retained = yield* Ref.make("");
    const read = child.all.pipe(
      Stream.decodeText(),
      Stream.interruptWhen(child.exitCode.pipe(Effect.delay("1 second"))),
      Stream.runForEach((chunk) =>
        Ref.updateAndGet(retained, (text) => `${text}${chunk}`.slice(-MAX_OUTPUT)).pipe(
          Effect.flatMap(output),
        ),
      ),
    );
    const [exit] = yield* Effect.all([child.exitCode, read], { concurrency: "unbounded" }).pipe(
      Effect.mapError(unavailable),
    );
    yield* close;
    if (Number(exit) !== 0) return yield* unavailable();
  });

  /**
   * Runs after the auth flow stops routed sessions: takes the provider-wide account
   * lease, then closes this instance's native sessions. A native process that may
   * still hold the account keeps the lease until the server restarts.
   */
  const prepare = Effect.fnUntraced(function* (operation: "start" | "logout") {
    if (usesKey)
      return yield* failure(
        operation,
        "Remove the instance's META_API_KEY before changing its native account.",
      );
    if (!canAuthenticateMuse(yield* options.snapshot.getSnapshot, usesKey))
      return yield* failure(
        operation,
        "Enable an installed, supported Muse runtime before changing its native account.",
      );
    yield* reserve(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    yield* (options.beforeChange ?? Effect.void).pipe(
      Effect.catchCause(() =>
        Ref.set(blocked, true).pipe(
          Effect.andThen(
            failure(
              "stopSessions",
              "Muse native sessions could not finish closing. Account credentials were not changed; restart this server before retrying.",
            ),
          ),
        ),
      ),
      Effect.uninterruptible,
    );
  });

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // The native Keychain can be shared despite distinct homes. Conservatively
    // coordinate every host-login instance; never claim unsupported account isolation.
    credentialBinding: {
      owner: "provider",
      key: usesKey ? `muse:explicit-key:${options.instanceId}` : "muse:native-host-account",
    },
    accountVerified: false,
    successMessage: "Muse saved your sign-in.",
    methods: options.snapshot.getSnapshot.pipe(
      Effect.map((snapshot) =>
        canAuthenticateMuse(snapshot, usesKey)
          ? [
              {
                id: "muse_device",
                name: "Meta account",
                description: null,
                type: "agent" as const,
              },
              {
                id: "muse_key",
                name: "Meta API key",
                description: "Required for Meta Managed Accounts.",
                type: "credentials" as const,
              },
            ]
          : [],
      ),
    ),
    authenticate: Effect.fnUntraced(function* (method, context) {
      yield* prepare("start");
      if (method === "muse_device") {
        let published = false;
        yield* run(["login"], (text) => {
          const interaction = readMuseDeviceInteraction(text);
          if (!interaction || published) return Effect.void;
          published = true;
          return context.setInteraction({
            type: "deviceCode",
            id: context.flowId,
            ...interaction,
          });
        });
        yield* context.verifying;
      } else if (method === "muse_key") {
        const key = yield* Deferred.make<string, ProviderSetupError>();
        yield* context.setInteraction(
          {
            type: "credentials",
            id: context.flowId,
            fields: [{ name: "apiKey", label: "Meta API key", secret: true }],
          },
          (response) => {
            const value = response.type === "credentials" ? response.values.apiKey?.trim() : "";
            if (!value || /[\r\n\0]/u.test(value))
              return Effect.fail(failure("respond", "Enter a Meta API key."));
            return Deferred.succeed(key, value).pipe(Effect.asVoid);
          },
        );
        const value = yield* Deferred.await(key);
        yield* context.verifying;
        yield* run(["auth", "set", "--api-key-stdin"], undefined, value);
      } else {
        return yield* failure("start", "Muse does not support this sign-in method.");
      }
      // Native exit success certifies the provider-owned write, not model entitlement.
      // Refresh runtime/catalog health without manufacturing a passive auth result.
      yield* options.onChanged;
    }),
    logout: Effect.scoped(
      Effect.gen(function* () {
        yield* prepare("logout");
        yield* run(["logout"]);
        yield* options.onChanged;
        return "Signed out of Muse.";
      }),
    ),
  });
  return {
    controller: {
      ...controller,
      isChangingCredentials: Ref.get(blocked).pipe(
        Effect.flatMap((failed) =>
          failed
            ? Effect.succeed(true)
            : (controller.isChangingCredentials ?? Effect.succeed(false)),
        ),
      ),
      withAccess: <A, E, R>(task: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const change = yield* coordinator.currentForProvider(MUSE_DRIVER);
          if ((yield* Ref.get(blocked)) || (change && !(usesKey && change.kind === "connection")))
            return yield* failure(
              "session",
              "Muse account or runtime changes are still running, or require process-shutdown recovery.",
            );
          return yield* controller.withAccess ? controller.withAccess(task) : task;
        }),
    },
    usesKey,
  };
});

/**
 * Background generation takes the same account lease as sessions. A sign-in that
 * stops it in flight is reported as a generation error, not a bare interruption.
 */
export function guardMuseTextGeneration(
  controller: Pick<ProviderAuthController, "withAccess">,
  generation: ProviderTextGeneration,
): ProviderTextGeneration {
  const guard = <A>(operation: string, task: Effect.Effect<A, TextGenerationError>) =>
    (controller.withAccess ? controller.withAccess(task) : task).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        cause._tag === "ProviderSetupError"
          ? new TextGenerationError({ operation, detail: cause.detail })
          : cause,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Muse's sign-in changed during generation. Try again.",
              }),
            )
          : Effect.failCause(cause),
      ),
    );
  return {
    generateCommitMessage: (input) =>
      guard("generateCommitMessage", generation.generateCommitMessage(input)),
    generatePrContent: (input) => guard("generatePrContent", generation.generatePrContent(input)),
    generateBranchName: (input) =>
      guard("generateBranchName", generation.generateBranchName(input)),
    generateThreadTitle: (input) =>
      guard("generateThreadTitle", generation.generateThreadTitle(input)),
    generateReviewGuide: (input) =>
      guard("generateReviewGuide", generation.generateReviewGuide(input)),
  };
}
