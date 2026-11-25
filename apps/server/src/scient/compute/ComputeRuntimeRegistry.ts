import { DataViewError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

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
import { makeSqlRuntimeBinding, PRIVATE_DUCKDB } from "./SqlComputeRuntime.ts";
import * as ToolDiscovery from "./ToolDiscovery.ts";
import { DataViewPython } from "../data/DataViewRuntime.ts";
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

class PythonBinding extends Context.Service<
  PythonBinding,
  { readonly binding: Effect.Success<typeof pythonRuntimeBinding> | undefined }
>()("t3/scient/compute/ComputeRuntimeRegistry/PythonBinding") {}

const pythonBindingLayer = Layer.effect(
  PythonBinding,
  optionalBinding("python", pythonRuntimeBinding).pipe(Effect.map(([binding]) => ({ binding }))),
);

export const dataViewPythonLayer = Layer.effect(
  DataViewPython,
  Effect.gen(function* () {
    const { binding } = yield* PythonBinding;
    const preferences = yield* ScientificRuntimePreferences;
    const host = binding?.kernelHost;
    const resolve = Effect.fn("DataViewPython.resolve")(
      function* (configuredExecutable: string | null) {
        if (host === undefined) return yield* new DataViewError({ reason: "runtime-unavailable" });
        const sql = makeSqlRuntimeBinding(host).adapter;
        // A file preview uses a host runtime, never an executable discovered inside the project.
        const profiles = yield* sql.discover({ projectRoot: null, configuredExecutable });
        for (const profile of profiles) {
          const verified = yield* sql.verify({ profile, cwd: ".", environment: {} });
          if (verified.readiness !== "ready") continue;
          if (verified.profile.executable !== PRIVATE_DUCKDB) {
            return verified.profile.executable;
          }
        }
        if (host.privateExecutable) return yield* host.privateExecutable();
        return yield* new DataViewError({ reason: "runtime-unavailable" });
      },
      Effect.mapError((cause) => new DataViewError({ reason: "runtime-unavailable", cause })),
    );
    const lock = yield* Semaphore.make(1);
    let current:
      | {
          readonly preference: string | null;
          readonly executable: Effect.Effect<string, DataViewError>;
        }
      | undefined;
    const cachedExecutable = Effect.gen(function* () {
      const preference = yield* preferences.readRuntimeExecutablePath("sql").pipe(
        Effect.map((value) => value.executablePath),
        Effect.orElseSucceed(() => null),
      );
      if (current?.preference === preference) return current.executable;
      const executable = yield* Effect.cachedWithTTL(resolve(preference), (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
      );
      current = { preference, executable };
      return executable;
    }).pipe(lock.withPermits(1), Effect.flatten);
    return { executable: cachedExecutable };
  }),
).pipe(Layer.provide(pythonBindingLayer));

/** Python and the languages whose kernels run behind its bridge. */
const pythonAndKernelBindings = Effect.gen(function* () {
  const { binding } = yield* PythonBinding;
  if (binding === undefined) return [];
  const host = binding.kernelHost;
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
  const bindLanguages = (projectRoot: string | null, known: ReadonlySet<string>) =>
    kernelLanguages(projectRoot).pipe(
      Effect.flatMap((languages) =>
        Effect.forEach(
          languages.filter((language) => !known.has(language.languageId)),
          (language) => makeInstalledKernelBinding(language, { host, configuredExecutable }),
        ),
      ),
    );
  const installed = yield* bindLanguages(null, new Set());
  const bound = new Set<string>(installed.map((binding) => binding.adapter.languageId));
  const lateBindings = (projectRoot: string | null) =>
    bindLanguages(projectRoot, bound).pipe(
      Effect.tap((added) =>
        Effect.sync(() => added.forEach((binding) => bound.add(binding.adapter.languageId))),
      ),
    );
  return [{ ...binding, lateBindings }, ...kernels, makeSqlRuntimeBinding(host), ...installed];
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
).pipe(Layer.provide(ToolDiscovery.layer), Layer.provide(pythonBindingLayer));
