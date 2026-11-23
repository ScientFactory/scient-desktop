// @effect-diagnostics nodeBuiltinImport:off -- a run's results folder is checked on disk.
import * as NodeFSP from "node:fs/promises";

import {
  ComputeResultsError,
  type ComputeResultsCompareResult,
  type ComputeResultsHistoryResult,
  type ComputeResultsPreviewResult,
  type ComputeResultsPublicationInput,
  type ComputeResultsPublicationResult,
  type ComputeResultsSetupResult,
  type ComputeResultOutputContent,
  type ComputeResultReference,
  type ComputeResultResolution,
  type ComputeResultScript,
  type ComputeResultSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { computeResultsStagingFolder } from "../compute/LocalComputeStore.ts";
import * as ComputeSessionService from "../compute/ComputeSessionService.ts";
import { inferTextColumnType } from "../data/cellText.ts";
import { compareResultRevisions } from "./resultComparison.ts";
import { parseCsv } from "./latexOutputs.ts";
import {
  isPlacementRefusal,
  type PlacementContext,
  type ProjectFiles,
} from "./resultPlacements.ts";
import {
  forgetResultAttempt,
  recordFailedResultAttempt,
  recoverResultAttempts,
  type ResultAttemptReceipt,
} from "./resultAttempts.ts";
import {
  makeResultsReader,
  publishScriptRun,
  readResultRunSetup,
  summarizeRevision,
  type PublishOutcome,
  type ResultsLayout,
} from "./resultRevisions.ts";

export interface ResultsProject {
  readonly projectId: string;
  readonly root: string;
}

export type ResultPublication =
  | { readonly _tag: "published"; readonly summary: ComputeResultSummary }
  | { readonly _tag: "failed"; readonly message: string };

/** Finished publications kept for a caller that asks after the run settled. */
const MAXIMUM_REMEMBERED_PUBLICATIONS = 200;

const resultsError = (message: string) => (cause: unknown) =>
  new ComputeResultsError({ message, cause });

/** The record of what fresh script runs published, on this computer. */
export class ComputeResults extends Context.Service<
  ComputeResults,
  {
    readonly resolve: (
      project: ResultsProject,
      references: ReadonlyArray<ComputeResultReference>,
    ) => Effect.Effect<ReadonlyArray<ComputeResultResolution>, ComputeResultsError>;
    readonly list: (
      project: ResultsProject,
      preferCurrent?: boolean,
      revision?: string,
    ) => Effect.Effect<ReadonlyArray<ComputeResultScript>, ComputeResultsError>;
    readonly setup: (
      project: ResultsProject,
      scriptPath: string,
    ) => Effect.Effect<Omit<ComputeResultsSetupResult, "suggestedInputs">, ComputeResultsError>;
    readonly history: (
      project: ResultsProject,
      scriptPath: string,
      includeLatest?: boolean,
    ) => Effect.Effect<ComputeResultsHistoryResult, ComputeResultsError>;
    readonly compare: (
      project: ResultsProject,
      from: string,
      to: string,
    ) => Effect.Effect<ComputeResultsCompareResult, ComputeResultsError>;
    readonly preview: (
      project: ResultsProject,
      revision: string,
      output: string,
    ) => Effect.Effect<ComputeResultsPreviewResult, ComputeResultsError>;
    readonly outputContent: (
      project: ResultsProject,
      revision: string,
      output: string,
    ) => Effect.Effect<ComputeResultOutputContent, ComputeResultsError>;
    readonly lastAttempt: (
      project: ResultsProject,
      scriptPath: string,
    ) => Effect.Effect<ResultAttemptReceipt | null, ComputeResultsError>;
    /** The stored bytes of a revision's figure, or null once retention removed them. */
    readonly figure: (
      project: ResultsProject,
      revision: string,
      output: string,
    ) => Effect.Effect<Uint8Array | null, ComputeResultsError>;
    /**
     * Runs a LaTeX placement step against the project's record. A refusal becomes the error's
     * message, which the app shows as it is.
     */
    readonly placements: <A>(
      project: ResultsProject,
      files: ProjectFiles,
      use: (context: PlacementContext) => Promise<A>,
    ) => Effect.Effect<A, ComputeResultsError>;
    readonly runPublication: (
      project: ResultsProject,
      run: Omit<ComputeResultsPublicationInput, "cwd">,
    ) => Effect.Effect<ComputeResultsPublicationResult, ComputeResultsError>;
    /** Ends the wait for a run that will never settle, such as one whose runtime never started. */
    readonly abandon: (
      projectId: string,
      sessionId: string,
      executionId: string,
    ) => Effect.Effect<void>;
    /** What publishing a run's results came to; it waits for the run to settle. */
    readonly publication: (
      projectId: string,
      sessionId: string,
      executionId: string,
    ) => Effect.Effect<ResultPublication>;
  }
>()("t3/scient/results/ComputeResults") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const compute = yield* ComputeSessionService.ComputeSessionService;
  const layout: ResultsLayout = { computeDir: config.computeDir };
  const publications = new Map<string, Deferred.Deferred<PublishOutcome>>();
  const publicationFor = (projectId: string, sessionId: string, executionId: string) => {
    const key = JSON.stringify([projectId, sessionId, executionId]);
    const existing = publications.get(key);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<PublishOutcome>();
    publications.set(key, created);
    // A caller may still be waiting on an unfinished one, so only finished ones are forgotten.
    if (publications.size > MAXIMUM_REMEMBERED_PUBLICATIONS) {
      for (const [candidate, deferred] of publications) {
        if (!Deferred.isDoneUnsafe(deferred)) continue;
        publications.delete(candidate);
        break;
      }
    }
    return created;
  };

  const publishSettled = Effect.fn("ComputeResults.publishSettled")(function* (
    settled: ComputeSessionService.ComputeSettledRun,
  ) {
    const { request, result } = settled.execution;
    const source = request.source;
    if (source._tag !== "document" || source.origin !== "file" || result === null) return;
    const publication = publicationFor(settled.projectId, request.sessionId, request.executionId);
    const stagingFolder = computeResultsStagingFolder(
      config.computeDir,
      settled.projectId,
      request.sessionId,
      request.executionId,
    );
    const staged =
      stagingFolder !== null &&
      (yield* Effect.promise(() =>
        NodeFSP.stat(stagingFolder).then(
          (status) => status.isDirectory(),
          () => false,
        ),
      ));
    if (stagingFolder === null || !staged) {
      yield* Deferred.succeed(publication, {
        _tag: "failed",
        message: "Only a whole saved script run from scratch publishes results.",
      });
      return;
    }
    const { session } = settled;
    const { outcome, parameters } = yield* Effect.tryPromise({
      try: async () => {
        const setup = await readResultRunSetup(stagingFolder);
        const environment =
          settled.packageEvidence === undefined
            ? setup?.environment
            : { lockfiles: setup?.environment?.lockfiles ?? [], ...settled.packageEvidence };
        const outcome = await publishScriptRun(layout, {
          ...setup,
          ...(environment === undefined ? {} : { environment }),
          projectId: settled.projectId,
          root: settled.root,
          stagingFolder,
          succeeded: result.status === "succeeded",
          scriptPath: source.path,
          language: session.label,
          code: request.code,
          sessionId: request.sessionId,
          executionId: request.executionId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt ?? request.submittedAt,
          threadId: request.actor?.threadId,
          runtime: {
            executable: session.runtime?.executable ?? null,
            version: session.identity?.languageVersion ?? session.runtime?.languageVersion ?? null,
            fingerprint: request.environmentFingerprint?.hash ?? null,
          },
          reads: result.reads,
        });
        return { outcome, parameters: setup?.parameters };
      },
      catch: resultsError("The run's results could not be recorded."),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("linked results could not be published", {
          executionId: request.executionId,
          cause: String(error.cause),
        }).pipe(
          Effect.as({
            outcome: {
              _tag: "failed" as const,
              message: "Scient could not record this run's results.",
            },
            parameters: undefined,
          }),
        ),
      ),
    );
    const run = {
      projectId: settled.projectId,
      sessionId: request.sessionId,
      executionId: request.executionId,
      scriptPath: source.path,
    };
    yield* Effect.tryPromise({
      try: () =>
        outcome._tag === "published"
          ? forgetResultAttempt(layout, run)
          : recordFailedResultAttempt(layout, run, {
              status: result.status === "cancelled" ? "cancelled" : "failed",
              finishedAt: result.finishedAt ?? request.submittedAt,
              message: result.failureReason || outcome.message,
              hasExecution: true,
              ...(parameters === undefined ? {} : { parameters }),
            }),
      catch: resultsError("The result attempt could not be recorded."),
    }).pipe(Effect.ignore({ log: true }));
    yield* Deferred.succeed(publication, outcome);
  });

  const recoveryTime = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* Effect.tryPromise({
    try: () =>
      recoverResultAttempts(layout, recoveryTime, async (run) =>
        (await makeResultsReader(layout, run.projectId, "").revisions()).some(
          (revision) =>
            revision.run.sessionId === run.sessionId &&
            revision.run.executionId === run.executionId,
        ),
      ),
    catch: resultsError("The result attempt journal could not be recovered."),
  }).pipe(Effect.ignore({ log: true }));

  yield* compute.settledRuns.pipe(
    Stream.runForEach((settled) =>
      publishSettled(settled).pipe(
        Effect.catchCause((cause) => Effect.logWarning("linked results not published", { cause })),
      ),
    ),
    Effect.forkScoped,
  );

  const reader = (project: ResultsProject) =>
    makeResultsReader(layout, project.projectId, project.root);

  const resolve = Effect.fn("ComputeResults.resolve")(function* (
    project: ResultsProject,
    references: ReadonlyArray<ComputeResultReference>,
  ) {
    const read = reader(project);
    return yield* Effect.tryPromise({
      try: () => Promise.all(references.map((reference) => read.resolve(reference))),
      catch: resultsError("The results could not be read."),
    });
  });

  const list = Effect.fn("ComputeResults.list")(function* (
    project: ResultsProject,
    preferCurrent?: boolean,
    revision?: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => reader(project).list(preferCurrent, revision),
      catch: resultsError("The results could not be read."),
    });
  });

  const setup = Effect.fn("ComputeResults.setup")(function* (
    project: ResultsProject,
    scriptPath: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => reader(project).setup(scriptPath),
      catch: resultsError("The result setup could not be read."),
    });
  });

  const history = Effect.fn("ComputeResults.history")(function* (
    project: ResultsProject,
    scriptPath: string,
    includeLatest = false,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const entries = (await reader(project).revisions()).filter(
          (entry) => entry.script.path === scriptPath,
        );
        const latest = includeLatest ? entries[0] : undefined;
        return {
          revisions: entries.map(({ revision, run, parameters }) => ({
            revision,
            finishedAt: run.finishedAt,
            ...(parameters === undefined ? {} : { parameters }),
          })),
          ...(latest === undefined ? {} : { latest }),
        };
      },
      catch: resultsError("The run history could not be read."),
    });
  });

  const compare = Effect.fn("ComputeResults.compare")(function* (
    project: ResultsProject,
    from: string,
    to: string,
  ) {
    const read = reader(project);
    const revisions = yield* Effect.tryPromise({
      try: () => read.revisions(),
      catch: resultsError("The run history could not be read."),
    });
    const older = revisions.find((entry) => entry.revision === from);
    const newer = revisions.find((entry) => entry.revision === to);
    if (older === undefined || newer === undefined)
      return yield* new ComputeResultsError({
        message: "A selected revision is unavailable in this project.",
      });
    return yield* Effect.tryPromise({
      try: () => compareResultRevisions(read, older, newer),
      catch: resultsError("The revisions could not be compared."),
    });
  });

  const preview = Effect.fn("ComputeResults.preview")(function* (
    project: ResultsProject,
    revision: string,
    output: string,
  ) {
    return yield* Effect.tryPromise({
      try: async (): Promise<ComputeResultsPreviewResult> => {
        const file = await reader(project).checkedOutputFile(revision, output);
        if (file._tag === "unavailable") return file;
        const { path, status, metadata } = file;
        if (metadata.kind === "figure")
          return { _tag: "figure", path, mediaType: metadata.mediaType };
        if (metadata.kind !== "table") return { _tag: "unavailable", reason: "missing" };
        const rows =
          status.size <= 4 * 1024 * 1024 ? parseCsv(await NodeFSP.readFile(path, "utf8")) : null;
        if (rows === null || rows.some((row) => row.some((cell) => cell.length > 4096)))
          return { _tag: "unavailable", reason: "table-limit" };
        const [headers = [], ...body] = rows;
        const columns = headers.map((name, index) => ({
          name,
          ...inferTextColumnType(body.map((cells) => cells[index])),
        }));
        return { _tag: "table", rows, columns };
      },
      catch: resultsError("The result preview could not be read."),
    });
  });

  const outputContent = Effect.fn("ComputeResults.outputContent")(function* (
    project: ResultsProject,
    revision: string,
    output: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => reader(project).outputContent(revision, output),
      catch: resultsError("The published output could not be read."),
    });
  });

  const lastAttempt = Effect.fn("ComputeResults.lastAttempt")(function* (
    project: ResultsProject,
    scriptPath: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => reader(project).lastAttempt(scriptPath),
      catch: resultsError("The last run could not be read."),
    });
  });

  const figure = Effect.fn("ComputeResults.figure")(function* (
    project: ResultsProject,
    revision: string,
    output: string,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const stored = await reader(project).figure(revision, output);
        return stored === null ? null : new Uint8Array(await NodeFSP.readFile(stored.path));
      },
      catch: resultsError("The figure could not be read."),
    });
  });

  const runPublication = Effect.fn("ComputeResults.runPublication")(function* (
    project: ResultsProject,
    run: Omit<ComputeResultsPublicationInput, "cwd">,
  ) {
    const read = reader(project);
    const stored = yield* Effect.tryPromise({
      try: () => read.findPublication(run),
      catch: resultsError("The run's publication could not be read."),
    });
    if (stored._tag !== "pending") return stored;
    const outcome = yield* Deferred.await(
      publicationFor(project.projectId, run.sessionId, run.executionId),
    ).pipe(Effect.timeoutOption("30 seconds"), Effect.map(Option.getOrNull));
    if (outcome === null) return { _tag: "unavailable" as const };
    if (outcome._tag === "failed") return outcome;
    return yield* Effect.tryPromise({
      try: () => read.published(outcome.revision),
      catch: resultsError("The run's publication could not be read."),
    });
  });

  const publication = Effect.fn("ComputeResults.publication")(function* (
    projectId: string,
    sessionId: string,
    executionId: string,
  ) {
    const outcome = yield* Deferred.await(publicationFor(projectId, sessionId, executionId));
    if (outcome._tag === "failed") return outcome;
    return {
      _tag: "published" as const,
      summary: summarizeRevision(
        outcome.revision,
        [
          ...outcome.revision.inputs.files,
          ...(outcome.revision.inputs.directories ?? []),
          ...(outcome.revision.inputs.globs ?? []),
        ]
          .filter((input) => input.changedDuringRun)
          .map((input) => ({ kind: "input-changed-during-run" as const, path: input.path })),
      ),
    };
  });

  const abandon = (projectId: string, sessionId: string, executionId: string) =>
    Deferred.succeed(publicationFor(projectId, sessionId, executionId), {
      _tag: "failed",
      message: "The run stopped before it started.",
    }).pipe(Effect.asVoid);

  const placements = <A>(
    project: ResultsProject,
    files: ProjectFiles,
    use: (context: PlacementContext) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: () =>
        use({
          layout,
          projectId: project.projectId,
          reader: reader(project),
          files,
          projectRoot: project.root,
        }),
      catch: (cause) =>
        isPlacementRefusal(cause)
          ? new ComputeResultsError({ message: cause.message })
          : new ComputeResultsError({ message: "The results files could not be changed.", cause }),
    }).pipe(Effect.withSpan("ComputeResults.placements"));

  return ComputeResults.of({
    resolve,
    list,
    setup,
    history,
    compare,
    preview,
    outputContent,
    lastAttempt,
    figure,
    placements,
    publication,
    runPublication,
    abandon,
  });
});

export const layer = Layer.effect(ComputeResults, make);
