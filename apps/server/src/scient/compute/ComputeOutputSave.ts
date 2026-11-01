import {
  ComputeGatewayError,
  type ComputeSaveProjectOutputInput,
  type ComputeSaveProjectOutputResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { ComputeRpcGateway } from "./ComputeRpcGateway.ts";
import type { ComputeSessionService } from "./ComputeSessionService.ts";

const MAXIMUM_NAME_ATTEMPTS = 100;

const saveError = (message: string, cause?: unknown) =>
  new ComputeGatewayError({
    operation: "save",
    reason: "operation-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** `figures/plot.pdf`, then `figures/plot-2.pdf`, `figures/plot-3.pdf`, … */
function candidatePath(relativePath: string, attempt: number): string {
  if (attempt === 1) return relativePath;
  const slash = relativePath.lastIndexOf("/");
  const dot = relativePath.lastIndexOf(".");
  return dot > slash + 1
    ? `${relativePath.slice(0, dot)}-${attempt}${relativePath.slice(dot)}`
    : `${relativePath}-${attempt}`;
}

/** Copies a run's stored figure into the project as an ordinary file. */
export function makeComputeOutputSave(input: {
  readonly gateway: Pick<ComputeRpcGateway, "getSession">;
  readonly compute: Pick<
    ComputeSessionService["Service"],
    "resolveOutputImage" | "resolveOutputResource"
  >;
  readonly workspaceFileSystem: Pick<
    WorkspaceFileSystem.WorkspaceFileSystem["Service"],
    "createBinaryFile"
  >;
  readonly fileSystem: Pick<FileSystem.FileSystem, "readFile">;
}) {
  return Effect.fn("ComputeOutputSave.save")(function* (request: ComputeSaveProjectOutputInput) {
    const session = yield* input.gateway.getSession({
      cwd: request.cwd,
      sessionId: request.sessionId,
    });
    if (session === null) return yield* saveError("This compute session is no longer available.");
    const ref = {
      projectId: session.projectId,
      sessionId: session.sessionId,
      executionId: request.executionId,
      contentHash: request.contentHash,
    };
    const resolved =
      request.kind === "image"
        ? yield* input.compute.resolveOutputImage(ref)
        : yield* input.compute.resolveOutputResource(ref);
    if (resolved === null) return yield* saveError("This output is no longer stored.");
    const bytes = yield* input.fileSystem
      .readFile(resolved.path)
      .pipe(Effect.mapError((cause) => saveError("The stored output could not be read.", cause)));
    for (let attempt = 1; attempt <= MAXIMUM_NAME_ATTEMPTS; attempt += 1) {
      const relativePath = candidatePath(request.relativePath, attempt);
      const written = yield* input.workspaceFileSystem
        .createBinaryFile({ cwd: request.cwd, relativePath, bytes })
        .pipe(
          Effect.map((result): ComputeSaveProjectOutputResult => ({
            relativePath: result.relativePath,
          })),
          Effect.catchTags({ WorkspaceFileExistsError: () => Effect.succeed(null) }),
          Effect.mapError((cause) =>
            saveError("The file could not be saved in the project.", cause),
          ),
        );
      if (written !== null) return written;
    }
    return yield* saveError("Too many files already use this name.");
  });
}
