// @effect-diagnostics nodeBuiltinImport:off -- agent package paths must stay in the bound workspace.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeResultRevisionId, ResultHandoffVerifyInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { agentScope, computeFailed, toolError } from "./agentComputeScope.ts";

const workspaceFolder = Effect.fn("ScientResultHandoff.workspaceFolder")(function* (
  cwd: string,
  path: string,
  allowRoot: boolean,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await NodeFSP.realpath(cwd);
      const requested = NodePath.resolve(root, path);
      const relative = NodePath.relative(root, requested);
      if (
        (!allowRoot && relative === "") ||
        NodePath.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`)
      ) {
        throw new Error("Path leaves the workspace.");
      }
      const resolved = await NodeFSP.realpath(requested);
      if (resolved !== requested || !(await NodeFSP.stat(resolved)).isDirectory()) {
        throw new Error("Path is not an unaliased folder.");
      }
      return resolved;
    },
    catch: () => toolError("compute-failed", "Choose an existing folder inside this project."),
  });
});

export const exportScientResults = Effect.fn("ScientResultHandoff.export")(function* (input: {
  readonly revision?: ComputeResultRevisionId | "" | undefined;
  readonly path?: string | undefined;
  readonly destination?: string | undefined;
  readonly includeInputs?: ReadonlyArray<string> | undefined;
  readonly excludeLockfiles?: ReadonlyArray<string> | undefined;
  readonly previewOnly?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  const request = {
    cwd: scope.cwd,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.previewOnly === true) {
    return yield* scope.gateway.resultHandoffChoices(request).pipe(Effect.mapError(computeFailed));
  }
  const destination = yield* workspaceFolder(scope.cwd, input.destination ?? ".", true);
  return yield* scope.gateway
    .exportResultPackage({
      ...request,
      destination,
      includeInputs: input.includeInputs ?? [],
      ...(input.excludeLockfiles === undefined ? {} : { excludeLockfiles: input.excludeLockfiles }),
    })
    .pipe(Effect.mapError(computeFailed));
});

export const verifyScientResults = Effect.fn("ScientResultHandoff.verify")(function* (
  input: ResultHandoffVerifyInput,
) {
  const scope = yield* agentScope();
  const packageFolder = yield* workspaceFolder(scope.cwd, input.packageFolder, false);
  const inputsFolder =
    input.inputsFolder === undefined
      ? undefined
      : yield* workspaceFolder(scope.cwd, input.inputsFolder, true);
  const result = yield* scope.gateway
    .verifyResultPackage({
      ...input,
      packageFolder,
      ...(inputsFolder === undefined ? {} : { inputsFolder }),
    })
    .pipe(Effect.mapError(computeFailed));
  const environment = result.report.environment;
  return {
    report: {
      ...result.report,
      ...(environment === null
        ? {}
        : {
            environment: {
              language: environment.language,
              version: environment.version,
              platform: environment.platform,
              architecture: environment.architecture,
              locale: environment.locale,
              timezone: environment.timezone,
            },
          }),
    },
    reportPath: result.reportPath,
    figures: result.figures.map(({ name, mediaType, originalPath, rerunPath }) => ({
      name,
      mediaType,
      originalPath,
      rerunPath,
    })),
  };
});
