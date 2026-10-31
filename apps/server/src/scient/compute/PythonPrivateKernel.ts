// @effect-diagnostics nodeBuiltinImport:off -- installs into Scient's own folder, never the person's.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ComputeRuntimeError } from "@scientfactory/compute";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as Effect from "effect/Effect";

import { privateKernelDirectory } from "./KernelSpecs.ts";
import {
  managedPythonProvisioningEnvironment,
  runOwnedProcess,
} from "./ManagedPythonProvisioner.ts";

function kernelError(message: string, cause?: unknown): ComputeRuntimeError {
  return new ComputeRuntimeError({
    operation: "prepare",
    message: message.slice(0, 4096),
    ...(cause === undefined ? {} : { cause }),
  });
}

/** One folder per interpreter and version, since compiled packages are built for one. */
export function makePythonPrivateKernels(input: {
  readonly computeDir: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly uv: (signal: AbortSignal) => Promise<string>;
}) {
  const installing = new Map<string, Promise<void>>();

  const install = async (executable: string, directory: string, signal: AbortSignal) => {
    const staging = `${directory}.new-${NodeCrypto.randomUUID()}`;
    await NodeFSP.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const { UV_MANAGED_PYTHON: _ignored, ...environment } = managedPythonProvisioningEnvironment(
        input.environment,
        {
          targetRoot: staging,
          projectRoot: staging,
          cacheRoot: NodePath.join(input.computeDir, "cache", "python"),
        },
      );
      await Effect.runPromise(
        runOwnedProcess(input.processes, {
          runId: `scient-python-kernel-${NodeCrypto.randomUUID()}`,
          executable: await input.uv(signal),
          args: [
            "pip",
            "install",
            "--python",
            executable,
            "--target",
            staging,
            "--no-config",
            "--no-progress",
            "--system-certs",
            "--color",
            "never",
            "ipykernel",
          ],
          cwd: staging,
          environment,
        }),
        { signal },
      );
      // A folder at its final name is complete.
      await NodeFSP.rename(staging, directory);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /** The folder that holds this Python's kernel, added the first time it is needed. */
  const ensure = (executable: string, realExecutable: string, version: string) => {
    const directory = privateKernelDirectory(input.computeDir, "python", realExecutable, version);
    return Effect.tryPromise({
      try: async (signal) => {
        const present = await NodeFSP.stat(directory).then(
          () => true,
          () => false,
        );
        if (present) return directory;
        const pending =
          installing.get(directory) ??
          install(executable, directory, signal).finally(() => installing.delete(directory));
        installing.set(directory, pending);
        await pending;
        return directory;
      },
      catch: (cause) =>
        kernelError(
          `Scient could not add a kernel for this Python: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        ),
    });
  };

  return { ensure };
}

export type PythonPrivateKernels = ReturnType<typeof makePythonPrivateKernels>;
