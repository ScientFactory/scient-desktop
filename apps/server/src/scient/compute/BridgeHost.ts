// @effect-diagnostics nodeBuiltinImport:off -- runs its own check inside an unpublished generation.
import * as NodeCrypto from "node:crypto";

import { ComputeRuntimeError } from "@scientfactory/compute";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as Effect from "effect/Effect";

import type { ComputeRecipeSource } from "./ComputeRecipeSource.ts";
import {
  type ManagedPythonEnvironmentDependencies,
  makeManagedPythonEnvironmentManager,
} from "./ManagedPythonEnvironment.ts";
import { makeManagedPythonProvisioner, runOwnedProcess } from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";
import bundledRecipeData from "./managed-python/bundled-recipes.json" with { type: "json" };

const bundledRecipe = bundledRecipeData.recipes.find((entry) => entry.purpose === "bridge-host")!;

function hostError(message: string, cause?: unknown): ComputeRuntimeError {
  return new ComputeRuntimeError({
    operation: "prepare",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * A small private Python, used only when a computer has no Python to host Scient's bridge. It is
 * plumbing: it never runs a person's code, and it is added the first time something needs it.
 */
export function makeBridgeHost(input: {
  readonly recipes: ComputeRecipeSource;
  readonly computeDir: string;
  readonly specDirectory: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}) {
  const verify: ManagedPythonEnvironmentDependencies["verify"] = async ({
    executable,
    pythonVersion,
    signal,
  }) => {
    await Effect.runPromise(
      runOwnedProcess(input.processes, {
        runId: `scient-bridge-host-check-${NodeCrypto.randomUUID()}`,
        executable,
        args: [
          "-I",
          "-B",
          "-c",
          [
            "import platform, sys",
            "import duckdb, ipykernel, jupyter_client",
            "assert platform.python_version() == sys.argv[1]",
          ].join("\n"),
          pythonVersion,
        ],
        cwd: input.computeDir,
        environment: input.environment,
      }),
      { signal },
    );
  };
  const provisioner = makeManagedPythonProvisioner({
    ...input,
    recipe: {
      lockSha256: bundledRecipe.lockSha256,
      projectSha256: bundledRecipe.projectSha256,
      verify,
    },
  });
  const manager = makeManagedPythonEnvironmentManager(
    input.computeDir,
    { provision: provisioner.provision, verify: provisioner.verify },
    "bridge-host",
    { trackUsage: true },
  );
  const controller = makeManagedPythonRuntimeController({
    recipes: input.recipes,
    manager,
    toolkitIds: [],
    configuration: {
      displayName: "Private Python host",
      description: "A small private Python that lets Scient run sessions on what you have.",
      toolkitRevision: bundledRecipe.toolkitRevision,
      pythonVersion: bundledRecipe.pythonVersion,
    },
  });
  const inspect = Effect.tryPromise({
    try: () => manager.inspect(),
    catch: (cause) => hostError("Scient's private Python could not be read.", cause),
  });

  /** The host's Python, installed the first time it is needed. Parallel sessions share one setup. */
  const executable = Effect.fn("BridgeHost.executable")(function* () {
    const current = yield* inspect;
    if (current?.available === true) return current.executable;
    const settled = controller.awaitSettled();
    yield* controller
      .manage(current === null ? "install" : "repair")
      .pipe(Effect.mapError((cause) => hostError(cause.message, cause)));
    const status = yield* settled.pipe(Effect.mapError((cause) => hostError(cause.message, cause)));
    const failure = status.failure?.detail ?? status.failureMessage;
    if (failure) return yield* hostError(`Scient could not add its private Python: ${failure}`);
    const installed = yield* inspect;
    if (installed?.available !== true)
      return yield* hostError("Scient's private Python did not finish installing.");
    return installed.executable;
  });

  return {
    executable,
    /** Keeps the generation a running session uses. An outside Python needs nothing. */
    acquire: (path: string) => manager.acquire(path),
    uv: (signal: AbortSignal) => provisioner.ensureUv(signal),
    reconcile: () => manager.reconcile(),
    dispose: () => controller.dispose(),
  };
}

export type BridgeHost = ReturnType<typeof makeBridgeHost>;
