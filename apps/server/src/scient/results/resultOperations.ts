// @effect-diagnostics nodeBuiltinImport:off -- ids are random UUIDs, an existing figure copy is compared on disk, and paths are POSIX.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeResultsError,
  ComputeSessionId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeResultReference,
  type ComputeResultsRerunResult,
} from "@t3tools/contracts";
import { findMarkdownResultReferences, resultReferenceState } from "@t3tools/shared/computeResults";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import type { ComputeRuntimeDescriptor } from "../compute/ComputeSessionService.ts";
import type { ComputeResults } from "./ComputeResults.ts";

/** How long a stopped run's own settlement may take to publish before Re-run reports the stop. */
const SETTLE_GRACE = Duration.seconds(30);

const failure = (message: string) => (cause: unknown) =>
  new ComputeResultsError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? `${message} ${String(cause.message)}`
        : message,
    cause,
  });

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** An earlier copy of the same figure counts only as a regular file inside the project. */
async function sameCopyInProject(root: string, relativePath: string, bytes: Uint8Array) {
  try {
    const target = NodePath.join(root, ...relativePath.split("/"));
    const [realRoot, realTarget, status] = await Promise.all([
      NodeFSP.realpath(root),
      NodeFSP.realpath(target),
      NodeFSP.lstat(target),
    ]);
    if (!status.isFile() || !realTarget.startsWith(`${realRoot}${NodePath.sep}`)) return false;
    return sha256(await NodeFSP.readFile(realTarget)) === sha256(bytes);
  } catch {
    return false;
  }
}

/**
 * The linked-results operations both doors use: the app's RPC and the agents' tools. Each takes the
 * project folder and resolves its Compute project the same way Compute does.
 */
export function makeResultOperations(input: {
  readonly gateway: Pick<ComputeRpcGateway, "project" | "startSession" | "getSession">;
  readonly results: ComputeResults["Service"];
  readonly runtimeDescriptors: ReadonlyArray<ComputeRuntimeDescriptor>;
  readonly workspace: Pick<
    WorkspaceFileSystem.WorkspaceFileSystem["Service"],
    "readFile" | "createBinaryFile"
  >;
}) {
  const project = (cwd: string) =>
    input.gateway
      .project({ cwd })
      .pipe(Effect.mapError(failure("The project could not be opened.")));

  const resolve = Effect.fn("ResultOperations.resolve")(function* (request: {
    readonly cwd: string;
    readonly references: ReadonlyArray<ComputeResultReference>;
  }) {
    const resolutions = yield* input.results.resolve(
      yield* project(request.cwd),
      request.references,
    );
    return { resolutions };
  });

  const list = Effect.fn("ResultOperations.list")(function* (request: { readonly cwd: string }) {
    return { scripts: yield* input.results.list(yield* project(request.cwd)) };
  });

  /** Copies a revision's figure beside the manuscript, so the manuscript keeps that exact figure. */
  const placeFigure = Effect.fn("ResultOperations.placeFigure")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
    readonly revision: string;
    readonly output: string;
  }) {
    const resultsProject = yield* project(request.cwd);
    const bytes = yield* input.results.figure(resultsProject, request.revision, request.output);
    if (bytes === null)
      return yield* new ComputeResultsError({
        message: "This revision's figure is no longer stored. Re-run the script.",
      });
    const extension = NodePath.posix.extname(request.output);
    const stem =
      NodePath.posix.basename(request.output, extension).replace(/[^\p{L}\p{N}._-]+/gu, "-") ||
      "figure";
    const folder = NodePath.posix.join(
      NodePath.posix.dirname(request.documentPath),
      "assets",
      "results",
    );
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const name = `${stem}-${request.revision}${attempt === 1 ? "" : `-${attempt}`}${extension}`;
      const relativePath = NodePath.posix.join(folder, name);
      const written = yield* input.workspace
        .createBinaryFile({ cwd: resultsProject.root, relativePath, bytes })
        .pipe(
          Effect.as(true),
          Effect.catchTags({ WorkspaceFileExistsError: () => Effect.succeed(false) }),
          Effect.mapError(failure("The figure could not be copied into the project.")),
        );
      if (
        written ||
        (yield* Effect.promise(() => sameCopyInProject(resultsProject.root, relativePath, bytes)))
      )
        return { src: `assets/results/${name}` };
    }
    return yield* new ComputeResultsError({
      message: "Too many files already use this figure's name.",
    });
  });

  /**
   * Runs the saved script from scratch, the way Run fresh does, and reports the revision it
   * published, or why it published none, including a run that stopped before it settled.
   */
  const rerun = Effect.fn("ResultOperations.rerun")(function* (request: {
    readonly cwd: string;
    readonly scriptPath: string;
    readonly threadId?: string;
  }) {
    const extension = NodePath.posix.extname(request.scriptPath).toLowerCase();
    const descriptor = input.runtimeDescriptors.find((candidate) =>
      candidate.sourceExtensions.some((known) => known.toLowerCase() === extension),
    );
    if (descriptor === undefined)
      return yield* new ComputeResultsError({
        message: `Scient cannot run ${extension || "this file"} from scratch. Linked results come from Python, R, Julia and other session languages.`,
      });
    const resultsProject = yield* project(request.cwd);
    const file = yield* input.workspace
      .readFile({ cwd: resultsProject.root, relativePath: request.scriptPath })
      .pipe(Effect.mapError(failure(`${request.scriptPath} could not be read.`)));
    if (file.truncated)
      return yield* new ComputeResultsError({
        message: `${request.scriptPath} is too large to run.`,
      });
    const sessionId = ComputeSessionId.make(NodeCrypto.randomUUID());
    const executionId = ComputeExecutionId.make(NodeCrypto.randomUUID());
    yield* input.gateway
      .startSession({
        cwd: resultsProject.root,
        sessionId,
        languageId: ComputeLanguageId.make(descriptor.languageId),
        executable: null,
        owner: { _tag: "file", path: request.scriptPath },
        runOnce: {
          executionId,
          code: file.contents,
          source: {
            _tag: "document",
            origin: "file",
            path: request.scriptPath,
            bufferState: "saved",
            revision: file.revision,
            range: null,
          },
          ...(request.threadId === undefined
            ? {}
            : { actor: { _tag: "agent" as const, threadId: request.threadId } }),
        },
      })
      .pipe(Effect.mapError(failure("The run could not start.")));
    // A session that ends before its run settles (a runtime that would not start) publishes nothing.
    const stopped = input.gateway.getSession({ cwd: resultsProject.root, sessionId }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.repeat({
        schedule: Schedule.spaced(Duration.seconds(1)),
        until: (session) =>
          session === null || TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
      }),
      Effect.delay(SETTLE_GRACE),
      Effect.map((session): ComputeResultsRerunResult => ({
        _tag: "failed",
        message: session?.lostReason ?? "The run stopped before it finished.",
      })),
    );
    return yield* Effect.raceFirst(input.results.publication(sessionId, executionId), stopped);
  });

  /** Every linked result in a Markdown manuscript, with the state the editor would show. */
  const check = Effect.fn("ResultOperations.check")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
  }) {
    const resultsProject = yield* project(request.cwd);
    const file = yield* input.workspace
      .readFile({ cwd: resultsProject.root, relativePath: request.documentPath })
      .pipe(Effect.mapError(failure(`${request.documentPath} could not be read.`)));
    const references = findMarkdownResultReferences(file.contents);
    const resolutions = yield* input.results.resolve(
      resultsProject,
      references.map(({ revision, output, pointer }) => ({ revision, output, pointer })),
    );
    return references.map((reference, index) => {
      const resolution = resolutions[index];
      return {
        reference,
        line: file.contents.slice(0, reference.start).split("\n").length,
        resolution,
        state: resultReferenceState(reference, resolution),
      };
    });
  });

  return { resolve, list, placeFigure, rerun, check };
}

export type ResultOperations = ReturnType<typeof makeResultOperations>;
