// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MANAGED_RUNTIME_POLICY,
  type ManagedScientAgentRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeSmokeEnvironment,
  managedRuntimeTargetKey,
  resolveScientAgentArtifactPolicy,
  smokeManagedRuntimeExecutable,
} from "@scientfactory/provider-runtime";
import type { ScientAgentSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { OMP_RPC_PROTOCOL_V2 } from "effect-omp-rpc/schema";

import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
  type OmpExecutableActivation,
  type OmpExecutableGateShape,
} from "../../provider/omp/OmpExecutableGate.ts";
import { OMP_ISOLATED_ARGS, makeOmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import { scientAgentTarget } from "../../provider/scient/ScientAgentTarget.ts";
import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ConfiguredRuntimeProbe,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  QualifiedRpcManagedRuntime,
  type ManagedRpcQualification,
} from "./QualifiedRpcManagedRuntime.ts";

type Dependencies = ConstructorParameters<typeof ManagedScientAgentRuntime>[1];

// Qualification must not read a real account or write to its state, even during
// the preliminary identity command or a native helper's early initialization.
const qualificationEnvironment = (
  environment: NodeJS.ProcessEnv,
  home: string,
): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    Object.entries(managedRuntimeSmokeEnvironment(environment)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  HOME: home,
  USERPROFILE: home,
  APPDATA: NodePath.join(home, "AppData", "Roaming"),
  LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
  SCIENT_AGENT_ROOT: NodePath.join(home, "scient-agent"),
});

/**
 * Scient Agent's RPC mode exits at startup when it has no model at all, and the
 * isolated home has none of the user's sign-ins. This stub provider gives it
 * one; the check never sends a prompt, so nothing is sent to its unroutable
 * address. Local-server discovery is off so the result does not depend on
 * what else runs on the machine.
 */
const SCIENT_QUALIFICATION_MODELS = `providers:
  scient-qualification:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    auth: none
    models:
      - id: stub
        name: Scient qualification stub
        input: [text]
        contextWindow: 8192
        maxTokens: 1024
`;
const SCIENT_QUALIFICATION_CONFIG = `disabledProviders:
  - ollama
  - llama.cpp
  - lm-studio
`;
/** A first launch of the large standalone binary can be slow on a cold machine. */
const SCIENT_QUALIFICATION_TIMEOUT = "30 seconds";

/**
 * A managed Scient Agent binary is not activated until it completes Scient's RPC v2
 * handshake and answers `get_state`, in an isolated home with no extensions,
 * tools, skills, rules or session.
 */
export const qualifyManagedScientAgentRuntime = Effect.fn("ScientAgentManagedRuntime.qualify")(
  function* (input: {
    readonly executablePath: string;
    readonly expectedVersion: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly activations: ReadonlyArray<OmpExecutableActivation>;
  }) {
    const identity = yield* canonicalOmpExecutablePath(input.executablePath);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const home = NodePath.join(input.cwd, "qualification-home");
        const root = NodePath.join(home, "scient-agent");
        const agent = NodePath.join(root, "agent");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(agent, { recursive: true, mode: 0o700 });
          await NodeFSP.writeFile(NodePath.join(agent, "models.yml"), SCIENT_QUALIFICATION_MODELS, {
            mode: 0o600,
          });
          await NodeFSP.writeFile(NodePath.join(agent, "config.yml"), SCIENT_QUALIFICATION_CONFIG, {
            mode: 0o600,
          });
        });
        const client = yield* makeOmpRpcProcess({
          target: scientAgentTarget,
          command: input.executablePath,
          cwd: input.cwd,
          env: {
            ...qualificationEnvironment(input.environment, home),
          },
          extraArgs: [...OMP_ISOLATED_ARGS],
          executableActivation: input.activations.find(
            (activation) => activation.identity === identity,
          ),
        }).pipe(Effect.timeout(SCIENT_QUALIFICATION_TIMEOUT));
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
              message: "The staged Scient Agent runtime did not offer Scient RPC protocol v2.",
            });
          }
          if (client.version !== input.expectedVersion) {
            return yield* new ProviderConnectionActionError({
              message: `The staged Scient Agent runtime reported ${client.version} instead of ${input.expectedVersion}.`,
            });
          }
          yield* client.getState();
        }).pipe(
          Effect.onExit(() => cleanup),
          Effect.timeout(SCIENT_QUALIFICATION_TIMEOUT),
        );
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderConnectionActionError
          ? cause
          : new ProviderConnectionActionError({
              message: "The staged Scient Agent runtime failed its RPC qualification check.",
              cause,
            }),
      ),
    );
  },
);

/** Private installation with executable admission, isolated smoke, and RPC qualification. */
export const makeQualifiedManagedScientAgentRuntime = Effect.fn(
  "ScientAgentManagedRuntime.makeRuntime",
)(function* (input: {
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly dependencies?: Dependencies;
  readonly qualification?: ManagedRpcQualification;
}) {
  const gate = yield* OmpExecutableGate;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const qualification: ManagedRpcQualification =
    input.qualification ??
    ((qualificationInput) =>
      qualifyManagedScientAgentRuntime({
        ...qualificationInput,
        environment: input.environment,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(OmpExecutableGate, gate),
      ));
  const smoke: NonNullable<Dependencies>["smoke"] = async (
    executable,
    args,
    name,
    environment,
    options,
  ) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-agent-smoke-"));
    try {
      await (input.dependencies?.smoke ?? smokeManagedRuntimeExecutable)(
        executable,
        args,
        name,
        qualificationEnvironment({ ...input.environment, ...environment }, directory),
        { ...options, cwd: directory },
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };
  return new QualifiedRpcManagedRuntime({
    baseDir: input.baseDir,
    identity: { providerDirectory: "scient-agent", displayName: scientAgentTarget.name },
    target: scientAgentTarget,
    gate,
    qualification,
    dependencies: { ...input.dependencies, smoke },
  });
});

/** Verify native identity, not a semver printed by an unrelated executable. */
const probeConfiguredScientAgentRuntime =
  (gate: OmpExecutableGateShape): ConfiguredRuntimeProbe =>
  (binary, environment, spawner) =>
    Effect.gen(function* () {
      const resolvedBinary = yield* resolveCommandPath(binary, {
        env: environment,
        bypassCache: true,
      }).pipe(Effect.orElseSucceed(() => binary));
      const identity = yield* canonicalOmpExecutablePath(resolvedBinary);
      yield* gate.acquireProcess(identity, { target: scientAgentTarget, kind: "one-shot" });
      const resolved = yield* resolveSpawnCommand(
        resolvedBinary,
        [...scientAgentTarget.identityArgs],
        { env: environment, extendEnv: false },
      );
      const result = yield* spawnAndCollect(
        resolvedBinary,
        ChildProcess.make(resolved.command, resolved.args, {
          env: environment,
          extendEnv: false,
          shell: resolved.shell,
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeout("5 seconds"),
      );
      const info = result.code === 0 ? scientAgentTarget.identify(result.stdout) : undefined;
      return info ? Option.some(info.version) : Option.none<string>();
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export const makeScientAgentManagedRuntimeResolution = Effect.fn(
  "ScientAgentManagedRuntime.makeResolution",
)(function* (input: {
  readonly settings: ScientAgentSettings;
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managedInstallationAllowed: boolean;
}): Effect.fn.Return<ManagedProviderRuntimeResolution, never, OmpExecutableGate> {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const target = detectTargetSafely({ platform, arch });
  const gate = yield* OmpExecutableGate;
  return yield* makeManagedProviderRuntimeResolution({
    configuredBinaryPath: input.settings.binaryPath,
    defaultBinary: "scient-agent",
    providerName: scientAgentTarget.name,
    providerSlug: "scient",
    runtime: yield* makeQualifiedManagedScientAgentRuntime({
      baseDir: input.baseDir,
      environment: input.environment,
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner)),
    bundledArtifact: undefined,
    artifactPolicy: target ? resolveScientAgentArtifactPolicy(target) : undefined,
    contractRevision: MANAGED_RUNTIME_POLICY.scient.revision,
    targetLabel: target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`,
    environment: input.environment,
    spawner: input.spawner,
    configuredRuntimeProbeAllowed: input.settings.enabled,
    probeConfiguredRuntime: probeConfiguredScientAgentRuntime(gate),
    managedInstallationAllowed: input.managedInstallationAllowed,
    systemToManagedSwitchAllowed: true,
    sourceLabel: "ScientFactory release",
    managedInstallationLimitation:
      "Scient can use a configured Scient Agent executable here, but managed installation is only enabled in the local desktop app.",
    diagnosticsHomePath: input.environment.SCIENT_AGENT_ROOT?.trim() || null,
    diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
  });
});
