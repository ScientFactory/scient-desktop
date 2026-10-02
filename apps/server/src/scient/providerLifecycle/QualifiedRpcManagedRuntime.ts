// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedProviderRuntime,
  ManagedProviderRuntimeError,
  type ManagedProviderRuntimeIdentity,
} from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  canonicalOmpExecutablePath,
  type OmpExecutableActivation,
  type OmpExecutableGateShape,
} from "../../provider/omp/OmpExecutableGate.ts";
import type { OmpTarget } from "../../provider/omp/OmpTarget.ts";
import type { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

export type ManagedRpcQualification = (input: {
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  readonly activations: ReadonlyArray<OmpExecutableActivation>;
}) => Effect.Effect<void, ProviderConnectionActionError>;

const runtimeError = (fallback: string, cause: unknown) =>
  cause instanceof DOMException && cause.name === "AbortError"
    ? cause
    : new ManagedProviderRuntimeError(cause instanceof Error ? cause.message : fallback, { cause });

/** Holds executable admission through RPC qualification and the durable activation commit. */
export class QualifiedRpcManagedRuntime extends ManagedProviderRuntime {
  private readonly root: string;
  private readonly target: OmpTarget;
  private readonly gate: OmpExecutableGateShape;
  private readonly qualification: ManagedRpcQualification;

  constructor(input: {
    readonly baseDir: string;
    readonly identity: ManagedProviderRuntimeIdentity;
    readonly target: OmpTarget;
    readonly gate: OmpExecutableGateShape;
    readonly qualification: ManagedRpcQualification;
    readonly dependencies?: ConstructorParameters<typeof ManagedProviderRuntime>[2];
  }) {
    super(input.baseDir, input.identity, input.dependencies);
    this.root = NodePath.join(input.baseDir, "provider-runtimes", input.identity.providerDirectory);
    this.target = input.target;
    this.gate = input.gate;
    this.qualification = input.qualification;
  }

  private async holdExecutables(executables: ReadonlyArray<string>, signal: AbortSignal) {
    const scope = await Effect.runPromise(Scope.make());
    const release = () => Effect.runPromise(Scope.close(scope, Exit.void));
    try {
      const activations = await Effect.runPromise(
        Effect.forEach(executables, canonicalOmpExecutablePath).pipe(
          Effect.flatMap((identities) =>
            Effect.forEach([...new Set(identities)], (identity) =>
              this.gate.acquireActivation(identity, { target: this.target }),
            ),
          ),
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(NodeServices.layer),
        ),
        { signal },
      );
      return { activations, release };
    } catch (cause) {
      await release();
      throw runtimeError(`Scient could not reserve the ${this.target.name} runtime.`, cause);
    }
  }

  override async install(input: Parameters<ManagedProviderRuntime["install"]>[0]) {
    let held: Awaited<ReturnType<QualifiedRpcManagedRuntime["holdExecutables"]>> | undefined;
    try {
      return await super.install({
        ...input,
        beforeActivate: async (signal) => {
          // The runtime manager waits for running work and closes idle sessions
          // before these holds prevent any new process from using either copy.
          await input.beforeActivate?.(signal);
          const active = await this.status(input.artifact);
          held = await this.holdExecutables(
            [active.launchPath, this.launchPath(input.artifact)],
            signal,
          );
        },
        qualify: async ({ artifact, executablePath, signal }) => {
          signal.throwIfAborted();
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), `scient-${this.target.stateNamespace}-qualification-`),
          );
          try {
            await Effect.runPromise(
              this.qualification({
                executablePath,
                expectedVersion: artifact.version,
                cwd: directory,
                activations: held?.activations ?? [],
              }),
              { signal },
            );
          } catch (cause) {
            throw runtimeError(
              `The staged ${this.target.name} runtime failed its RPC qualification check.`,
              cause,
            );
          } finally {
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }
        },
      });
    } finally {
      await held?.release();
    }
  }

  override async remove() {
    const state = await this.readState();
    const held = state
      ? await this.holdExecutables(
          [NodePath.resolve(this.root, state.executableRelativePath)],
          new AbortController().signal,
        )
      : undefined;
    try {
      await super.remove();
    } finally {
      await held?.release();
    }
  }
}
