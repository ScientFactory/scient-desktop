// @effect-diagnostics nodeBuiltinImport:off -- session and execution ids are random UUIDs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeResultsError,
  ComputeSessionId,
  type ComputeResultsRerunResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import type { ComputeRuntimeDescriptor } from "../compute/ComputeSessionService.ts";
import type { ComputeResults } from "./ComputeResults.ts";

export interface ResultScriptRunner {
  readonly gateway: Pick<ComputeRpcGateway, "startSession">;
  readonly results: ComputeResults["Service"];
  readonly runtimeDescriptors: ReadonlyArray<ComputeRuntimeDescriptor>;
  readonly readFile: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["readFile"];
}

const failure = (message: string) => (cause: unknown) =>
  new ComputeResultsError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? `${message} ${String(cause.message)}`
        : message,
    cause,
  });

/**
 * Runs the saved script from scratch, the way Run in a fresh session does, and reports the result
 * revision it published. The code is the file as saved, so the revision names exactly what ran.
 */
export const runScriptForResults = Effect.fn("ComputeResults.runScript")(function* (
  runner: ResultScriptRunner,
  input: {
    readonly cwd: string;
    readonly scriptPath: string;
    readonly threadId?: string;
  },
) {
  const extension = NodePath.extname(input.scriptPath).toLowerCase();
  const descriptor = runner.runtimeDescriptors.find((candidate) =>
    candidate.sourceExtensions.some((known) => known.toLowerCase() === extension),
  );
  if (descriptor === undefined)
    return yield* new ComputeResultsError({
      message: `Scient cannot run ${extension || "this file"} from scratch. Linked results come from Python, R, Julia and other session languages.`,
    });
  const file = yield* runner
    .readFile({ cwd: input.cwd, relativePath: input.scriptPath })
    .pipe(Effect.mapError(failure(`${input.scriptPath} could not be read.`)));
  if (file.truncated)
    return yield* new ComputeResultsError({ message: `${input.scriptPath} is too large to run.` });
  const executionId = ComputeExecutionId.make(NodeCrypto.randomUUID());
  yield* runner.gateway
    .startSession({
      cwd: input.cwd,
      sessionId: ComputeSessionId.make(NodeCrypto.randomUUID()),
      languageId: ComputeLanguageId.make(descriptor.languageId),
      executable: null,
      owner: { _tag: "file", path: input.scriptPath },
      runOnce: {
        executionId,
        code: file.contents,
        source: {
          _tag: "document",
          origin: "file",
          path: input.scriptPath,
          bufferState: "saved",
          revision: file.revision,
          range: null,
        },
        ...(input.threadId === undefined
          ? {}
          : { actor: { _tag: "agent" as const, threadId: input.threadId } }),
      },
    })
    .pipe(Effect.mapError(failure("The run could not start.")));
  const outcome = yield* runner.results.publication(executionId);
  return outcome satisfies ComputeResultsRerunResult;
});
