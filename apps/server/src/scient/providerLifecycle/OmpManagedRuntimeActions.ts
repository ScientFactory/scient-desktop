// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MANAGED_RUNTIME_POLICY,
  ManagedOmpRuntime,
  ManagedProviderRuntimeError,
  detectManagedRuntimeTarget,
  managedRuntimeSmokeEnvironment,
  managedRuntimeTargetKey,
  resolveReviewedOmpArtifact,
} from "@scientfactory/provider-runtime";
import type { OmpSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { OMP_RPC_PROTOCOL_V2 } from "effect-omp-rpc/schema";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import { OMP_ISOLATED_ARGS, makeOmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";

const DEFAULT_OMP_BINARY = "omp";

class QualifiedManagedOmpRuntime extends ManagedOmpRuntime {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];

  constructor(
    baseDir: string,
    environment: NodeJS.ProcessEnv,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) {
    super(baseDir);
    this.environment = environment;
    this.spawner = spawner;
  }

  override async install(input: Parameters<ManagedOmpRuntime["install"]>[0]) {
    return super.install({
      ...input,
      qualify: async ({ artifact, executablePath, signal }) => {
        signal.throwIfAborted();
        const directory = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "scient-omp-qualification-"),
        );
        try {
          await Effect.runPromise(
            qualifyManagedOmpRuntime({
              executablePath,
              expectedVersion: artifact.version,
              cwd: directory,
              environment: this.environment,
              spawner: this.spawner,
            }),
            { signal },
          );
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
          throw new ManagedProviderRuntimeError(
            cause instanceof Error
              ? cause.message
              : "The staged Oh My Pi runtime failed its RPC qualification check.",
            { cause },
          );
        } finally {
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      },
    });
  }
}

/** A managed OMP binary is not activated until it can complete Scient's RPC handshake. */
const qualifyManagedOmpRuntime = Effect.fn("OmpManagedRuntime.qualify")(function* (input: {
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const home = NodePath.join(input.cwd, "qualification-home");
      yield* Effect.promise(() => NodeFSP.mkdir(home, { recursive: true, mode: 0o700 }));
      const client = yield* makeOmpRpcProcess({
        command: input.executablePath,
        cwd: input.cwd,
        env: {
          ...managedRuntimeSmokeEnvironment(input.environment),
          HOME: home,
          PI_CODING_AGENT_DIR: NodePath.join(home, "agent"),
        },
        extraArgs: [...OMP_ISOLATED_ARGS],
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
        Effect.timeout("8 seconds"),
      );
      const cleanup = client.shutdown.pipe(
        Effect.ignore,
        Effect.andThen(client.close()),
        Effect.uninterruptible,
      );
      yield* Effect.gen(function* () {
        const ready = yield* client.ready;
        // OMP advertises v2 in supportedProtocolVersions while its ready
        // envelope remains on the v1 wire shape.
        if (!ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_V2)) {
          return yield* new ProviderConnectionActionError({
            message: "The staged Oh My Pi runtime did not offer Scient RPC protocol v2.",
          });
        }
        if (client.version !== input.expectedVersion) {
          return yield* new ProviderConnectionActionError({
            message: `The staged Oh My Pi runtime reported ${client.version} instead of ${input.expectedVersion}.`,
          });
        }
        yield* client.getState();
      }).pipe(
        Effect.onExit(() => cleanup),
        Effect.timeout("8 seconds"),
        Effect.mapError((cause) =>
          cause instanceof ProviderConnectionActionError
            ? cause
            : new ProviderConnectionActionError({
                message: "The staged Oh My Pi runtime failed its RPC qualification check.",
                cause,
              }),
        ),
      );
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
  );
});

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export const makeOmpManagedRuntimeResolution = Effect.fn("OmpManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: OmpSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<ManagedProviderRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedOmpArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;
    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_OMP_BINARY,
      providerName: "Oh My Pi",
      providerSlug: "omp",
      runtime: new QualifiedManagedOmpRuntime(input.baseDir, input.environment, input.spawner),
      bundledArtifact: artifact,
      contractRevision: MANAGED_RUNTIME_POLICY.omp.revision,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Oh My Pi release",
      managedInstallationLimitation:
        "Scient can use a healthy Oh My Pi runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
