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
  type ComputeResultsRerunInput,
  type ComputeResultsAttemptOutputInput,
  type ComputeResultsCompareInput,
  type ComputeResultsHistoryInput,
  type ComputeResultsListInput,
  type ComputeResultsPreviewInput,
  type ComputeResultsPublicationInput,
  type ComputeResultsSetupInput,
  type ComputeResultsRerunResult,
} from "@t3tools/contracts";
import { findMarkdownResultReferences, resultReferenceState } from "@t3tools/shared/computeResults";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import type { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import type { ComputeRuntimeDescriptor } from "../compute/ComputeSessionService.ts";
import { suggestedResultInputs, supportsResultInputSuggestions } from "./resultRevisions.ts";
import type { ComputeResults } from "./ComputeResults.ts";
import {
  placeLatexResult,
  placementStatus,
  undoPlacedFilesUpdate,
  updatePlacedFiles,
  type ProjectFiles,
} from "./resultPlacements.ts";

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
 * The path inside the project when it is reached without links: the file, or the nearest folder
 * that exists on the way to it, is where its name says. Null for a link or a path that leaves.
 */
async function unaliasedPath(root: string, relativePath: string): Promise<string | null> {
  try {
    const realRoot = await NodeFSP.realpath(root);
    const target = NodePath.join(realRoot, ...relativePath.split("/"));
    if (!target.startsWith(`${realRoot}${NodePath.sep}`)) return null;
    for (
      let existing = target;
      existing.startsWith(realRoot);
      existing = NodePath.dirname(existing)
    ) {
      const status = await NodeFSP.lstat(existing).catch(() => null);
      if (status === null) continue;
      if (status.isSymbolicLink()) return null;
      return (await NodeFSP.realpath(existing)) === existing ? target : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bytes of a regular file inside the project, or null when nothing is there. A path reached
 * through a link, or anything but a regular file, throws: it is neither absent nor the placed file.
 */
async function readProjectFile(root: string, relativePath: string): Promise<Uint8Array | null> {
  const target = await unaliasedPath(root, relativePath);
  if (target === null)
    throw new Error(`${relativePath} is reached through a link, so Scient does not change it.`);
  const status = await NodeFSP.lstat(target).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return null;
    throw cause;
  });
  if (status === null) return null;
  if (!status.isFile()) throw new Error(`${relativePath} is not a regular file.`);
  return new Uint8Array(await NodeFSP.readFile(target));
}

const requireUnaliased = async (root: string, relativePath: string) => {
  if ((await unaliasedPath(root, relativePath)) === null)
    throw new Error(`${relativePath} is reached through a link, so Scient does not change it.`);
};

/**
 * The linked-results operations both doors use: the app's RPC and the agents' tools. Each takes the
 * project folder and resolves its Compute project the same way Compute does.
 */
export function makeResultOperations(input: {
  readonly gateway: Pick<
    ComputeRpcGateway,
    "project" | "startSession" | "getSession" | "listExecutions" | "listOutputs"
  >;
  readonly results: ComputeResults["Service"];
  readonly runNotebookFresh: ReturnType<typeof makeNotebookRuns>["run"];
  readonly runtimeDescriptors: ReadonlyArray<ComputeRuntimeDescriptor>;
  readonly workspace: Pick<
    WorkspaceFileSystem.WorkspaceFileSystem["Service"],
    "readFile" | "createBinaryFile" | "writeBinaryFile"
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

  const list = Effect.fn("ResultOperations.list")(function* (request: ComputeResultsListInput) {
    return {
      scripts: yield* input.results.list(
        yield* project(request.cwd),
        request.preferCurrent,
        request.revision,
      ),
    };
  });

  const outputContent = Effect.fn("ResultOperations.outputContent")(function* (request: {
    readonly cwd: string;
    readonly revision: string;
    readonly output: string;
  }) {
    return yield* input.results.outputContent(
      yield* project(request.cwd),
      request.revision,
      request.output,
    );
  });

  const setup = Effect.fn("ResultOperations.setup")(function* (request: ComputeResultsSetupInput) {
    const resultsProject = yield* project(request.cwd);
    const defaults = input.results.setup(resultsProject, request.scriptPath);
    const suggestedInputs = supportsResultInputSuggestions(request.scriptPath)
      ? input.workspace
          .readFile({ cwd: resultsProject.root, relativePath: request.scriptPath })
          .pipe(
            Effect.flatMap((file) =>
              Effect.tryPromise({
                try: () =>
                  suggestedResultInputs(resultsProject.root, request.scriptPath, file.contents),
                catch: failure("Input suggestions could not be read."),
              }),
            ),
            Effect.orElseSucceed(() => []),
          )
      : Effect.succeed([]);
    const [saved, suggestions] = yield* Effect.all([defaults, suggestedInputs], {
      concurrency: "unbounded",
    });
    return { ...saved, suggestedInputs: suggestions };
  });

  const history = Effect.fn("ResultOperations.history")(function* (
    request: ComputeResultsHistoryInput,
  ) {
    return yield* input.results.history(
      yield* project(request.cwd),
      request.scriptPath,
      request.includeLatest,
    );
  });

  const compare = Effect.fn("ResultOperations.compare")(function* (
    request: ComputeResultsCompareInput,
  ) {
    return yield* input.results.compare(yield* project(request.cwd), request.from, request.to);
  });

  const preview = Effect.fn("ResultOperations.preview")(function* (
    request: ComputeResultsPreviewInput,
  ) {
    return yield* input.results.preview(
      yield* project(request.cwd),
      request.revision,
      request.output,
    );
  });

  const runPublication = Effect.fn("ResultOperations.runPublication")(function* (
    request: ComputeResultsPublicationInput,
  ) {
    return yield* input.results.runPublication(yield* project(request.cwd), request);
  });

  const attemptOutput = Effect.fn("ResultOperations.attemptOutput")(function* (
    request: ComputeResultsAttemptOutputInput,
  ) {
    const resultsProject = yield* project(request.cwd);
    const attempt = yield* input.results.lastAttempt(resultsProject, request.scriptPath);
    if (attempt === null || attempt.finishedAt !== request.finishedAt)
      return yield* new ComputeResultsError({
        message: "The last run has changed. Open its output again.",
      });
    const sessionTarget = { cwd: resultsProject.root, sessionId: attempt.sessionId };
    const executionId = attempt.hasExecution
      ? (attempt.cellExecutionId ?? attempt.executionId)
      : null;
    const { output, session } = yield* Effect.all(
      {
        output: input.gateway.listOutputs({ ...sessionTarget, executionId }),
        session: input.gateway.getSession(sessionTarget),
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(failure("The run output could not be read.")));
    return {
      output,
      session,
      executionId,
      ...(attempt.cellId === undefined ? {} : { cellId: attempt.cellId }),
      ...(attempt.parameters === undefined ? {} : { parameters: attempt.parameters }),
    };
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
      NodePath.posix.dirname(request.documentPath.replaceAll("\\", "/")),
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
  const rerun = Effect.fn("ResultOperations.rerun")(function* (
    request: ComputeResultsRerunInput & {
      readonly threadId?: string;
    },
  ): Effect.fn.Return<ComputeResultsRerunResult, ComputeResultsError> {
    const extension = NodePath.posix.extname(request.scriptPath).toLowerCase();
    if (extension === ".ipynb") return yield* input.runNotebookFresh(request);
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
          ...(request.parameters === undefined ? {} : { parameters: request.parameters }),
          ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
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
    // A session that ends before it ever ran the script (a runtime that would not start) has no
    // run to settle, so nothing would publish; a run that did start always settles and publishes.
    const stopped = input.gateway.getSession({ cwd: resultsProject.root, sessionId }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.repeat({
        schedule: Schedule.spaced(Duration.seconds(1)),
        until: (session) =>
          session === null || TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
      }),
      Effect.flatMap((session) =>
        input.gateway.listExecutions({ cwd: resultsProject.root, sessionId, limit: 200 }).pipe(
          Effect.orElseSucceed(() => []),
          Effect.flatMap((executions) =>
            executions.some((execution) => execution.request.executionId === executionId)
              ? Effect.never
              : input.results.abandon(resultsProject.projectId, sessionId, executionId).pipe(
                  Effect.as<ComputeResultsRerunResult>({
                    _tag: "failed",
                    message: session?.lostReason ?? "The run stopped before it started.",
                  }),
                ),
          ),
        ),
      ),
    );
    return yield* Effect.raceFirst(
      input.results.publication(resultsProject.projectId, sessionId, executionId),
      stopped,
    );
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
        // From source, a table's cells are not compared; only its run is.
        state: resultReferenceState(
          reference.kind === "table" ? { kind: "table", rows: null } : reference,
          resolution,
        ),
      };
    });
  });

  /**
   * Project files through the workspace's guarded writer: a write lands only on the bytes the
   * caller saw, and an open editor hears about it.
   */
  const projectFiles = (root: string): ProjectFiles => ({
    read: (path) => readProjectFile(root, path),
    write: async (path, bytes, expectedSha256) => {
      await requireUnaliased(root, path);
      return Effect.runPromise(
        input.workspace
          .writeBinaryFile({
            cwd: root,
            relativePath: path,
            bytes,
            ...(expectedSha256 === null
              ? { createOnly: true as const }
              : { expectedRevision: `sha256:${expectedSha256}` }),
          })
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              WorkspaceFileExistsError: () => Effect.succeed(false),
              WorkspaceFileRevisionConflictError: () => Effect.succeed(false),
            }),
          ),
      );
    },
    // The workspace's delete is for text files; a placed figure can be binary or large. Removal
    // happens only when the whole file still holds the bytes the update wrote.
    remove: async (path, expectedSha256) => {
      const target = await unaliasedPath(root, path);
      if (target === null)
        throw new Error(`${path} is reached through a link, so Scient does not change it.`);
      const current = await readProjectFile(root, path);
      if (current === null || sha256(current) !== expectedSha256) return false;
      await NodeFSP.rm(target);
      return true;
    },
  });

  const documentFile = (root: string, documentPath: string) =>
    input.workspace
      .readFile({ cwd: root, relativePath: documentPath })
      .pipe(Effect.mapError(failure(`${documentPath} could not be read.`)));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** Places a value, table or figure for a LaTeX paper and says what to insert. */
  const placeLatex = Effect.fn("ResultOperations.placeLatex")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
    readonly setup?: string | undefined;
    readonly revision: string;
    readonly output: string;
    readonly pointer: string | null;
  }) {
    const resultsProject = yield* project(request.cwd);
    const { contents: text } = yield* documentFile(resultsProject.root, request.documentPath);
    const placedAt = yield* now;
    return yield* input.results.placements(
      resultsProject,
      projectFiles(resultsProject.root),
      (context) =>
        placeLatexResult(context, {
          documentPath: request.documentPath,
          // The editor's setup includes the preamble's included files, which the root alone lacks.
          documentText: `${text}\n${request.setup ?? ""}`,
          revision: request.revision,
          output: request.output,
          pointer: request.pointer,
          now: placedAt,
        }),
    );
  });

  /** The placed files under a LaTeX paper's root, and whether the shown PDF used them. */
  const placements = Effect.fn("ResultOperations.placements")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
    readonly build: {
      readonly finishedAt: string;
      readonly digests: Readonly<Record<string, string>>;
    } | null;
  }) {
    const resultsProject = yield* project(request.cwd);
    const file = yield* documentFile(resultsProject.root, request.documentPath);
    return yield* input.results.placements(
      resultsProject,
      projectFiles(resultsProject.root),
      (context) =>
        placementStatus(context, {
          documentPath: request.documentPath,
          documentText: file.contents,
          documentTruncated: file.truncated,
          build: request.build,
        }),
    );
  });

  const updateFiles = Effect.fn("ResultOperations.updateFiles")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
    readonly scriptPath: string;
    readonly toRevision: string;
    readonly replaceEdited: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  }) {
    const resultsProject = yield* project(request.cwd);
    const file = yield* documentFile(resultsProject.root, request.documentPath);
    const updatedAt = yield* now;
    return yield* input.results.placements(
      resultsProject,
      projectFiles(resultsProject.root),
      (context) =>
        updatePlacedFiles(context, {
          documentPath: request.documentPath,
          documentText: file.contents,
          documentTruncated: file.truncated,
          script: request.scriptPath,
          toRevision: request.toRevision,
          replaceEdited: request.replaceEdited,
          now: updatedAt,
        }),
    );
  });

  const undoUpdate = Effect.fn("ResultOperations.undoUpdate")(function* (request: {
    readonly cwd: string;
    readonly documentPath: string;
    readonly scriptPath: string;
  }) {
    const resultsProject = yield* project(request.cwd);
    return yield* input.results.placements(
      resultsProject,
      projectFiles(resultsProject.root),
      (context) =>
        undoPlacedFilesUpdate(context, {
          documentPath: request.documentPath,
          script: request.scriptPath,
        }),
    );
  });

  return {
    resolve,
    list,
    outputContent,
    attemptOutput,
    runPublication,
    setup,
    history,
    compare,
    preview,
    placeFigure,
    rerun,
    check,
    placeLatex,
    placements,
    updateFiles,
    undoUpdate,
  };
}

export type ResultOperations = ReturnType<typeof makeResultOperations>;
