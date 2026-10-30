import * as Effect from "effect/Effect";

import * as ComputeProjectOutputObserver from "./ComputeProjectOutputObserver.ts";
import {
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  type ComputeRuntimeBinding,
  layerWithRuntimeBindings,
} from "./ComputeSessionService.ts";
import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";
import { kernelLanguages, makeInstalledKernelBinding } from "./InstalledKernelRuntime.ts";
import { makeKernelRuntimeBinding } from "./KernelComputeRuntime.ts";
import { matlabRuntimeBinding } from "./MatlabComputeRuntime.ts";
import { pythonRuntimeBinding } from "./PythonComputeRuntime.ts";
import { R_KERNEL_LANGUAGE } from "./RComputeRuntime.ts";
import { ScientificRuntimePreferences } from "./ScientificRuntimePreferences.ts";
import { makeSqlRuntimeBinding } from "./SqlComputeRuntime.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { ServerConfig } from "../../config.ts";

function optionalBinding<B extends ComputeRuntimeBinding, E, R>(
  label: string,
  binding: Effect.Effect<B, E, R>,
): Effect.Effect<ReadonlyArray<B>, never, R> {
  return binding.pipe(
    Effect.map((value) => [value]),
    Effect.catch((cause) =>
      Effect.logWarning(`compute runtime '${label}' is unavailable`, {
        reason: String(cause),
      }).pipe(Effect.as([])),
    ),
  );
}

/** Python and the languages whose kernels run behind its bridge. */
const pythonAndKernelBindings = Effect.gen(function* () {
  const python = yield* optionalBinding("python", pythonRuntimeBinding);
  const host = python[0]?.kernelHost;
  if (host === undefined) return python;
  const config = yield* ServerConfig;
  const processes = yield* ExecutionProcess;
  const preferences = yield* ScientificRuntimePreferences;
  const configuredExecutable = (languageId: string) =>
    preferences.readRuntimeExecutablePath(languageId).pipe(
      Effect.map((preference) => preference.executablePath),
      Effect.orElseSucceed(() => null),
    );
  const kernels = yield* Effect.forEach([R_KERNEL_LANGUAGE, JULIA_KERNEL_LANGUAGE], (language) =>
    makeKernelRuntimeBinding(language, {
      host,
      computeDir: config.computeDir,
      processes,
      configuredExecutable,
    }),
  );
  // Each language once; a language outside Scient's list appears after a restart.
  const installed = yield* kernelLanguages().pipe(
    Effect.flatMap((languages) =>
      Effect.forEach(languages, (language) =>
        makeInstalledKernelBinding(language, { host, configuredExecutable }),
      ),
    ),
  );
  return [...python, ...kernels, makeSqlRuntimeBinding(host), ...installed];
});

/**
 * Production compute bindings. A missing optional runtime disables only that
 * language; it never prevents the editor or another language from starting.
 */
export const layer = layerWithRuntimeBindings(
  Effect.all([pythonAndKernelBindings, optionalBinding("matlab", matlabRuntimeBinding)], {
    concurrency: 2,
  }).pipe(Effect.map((bindings) => bindings.flat())),
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  ComputeProjectOutputObserver.liveLayer,
);
