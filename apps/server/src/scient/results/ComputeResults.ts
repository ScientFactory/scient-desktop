// @effect-diagnostics nodeBuiltinImport:off -- a run's results folder is checked on disk.
import * as NodeFSP from "node:fs/promises";

import {
  ComputeResultsError,
  type ComputeResultReference,
  type ComputeResultResolution,
  type ComputeResultScript,
  type ComputeResultSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { computeResultsStagingFolder } from "../compute/LocalComputeStore.ts";
import * as ComputeSessionService from "../compute/ComputeSessionService.ts";
import {
  makeResultsReader,
  publishScriptRun,
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
    ) => Effect.Effect<ReadonlyArray<ComputeResultScript>, ComputeResultsError>;
    /** The stored bytes of a revision's figure, or null once retention removed them. */
    readonly figure: (
      project: ResultsProject,
      revision: string,
      output: string,
    ) => Effect.Effect<Uint8Array | null, ComputeResultsError>;
    /** What publishing a run's results came to; it waits for the run to settle. */
    readonly publication: (
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
  const publicationFor = (sessionId: string, executionId: string) => {
    const key = `${sessionId}/${executionId}`;
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
    const publication = publicationFor(request.sessionId, request.executionId);
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
    const outcome = yield* Effect.tryPromise({
      try: () =>
        publishScriptRun(layout, {
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
        }),
      catch: resultsError("The run's results could not be recorded."),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("linked results could not be published", {
          executionId: request.executionId,
          cause: String(error.cause),
        }).pipe(
          Effect.as<PublishOutcome>({
            _tag: "failed",
            message: "Scient could not record this run's results.",
          }),
        ),
      ),
    );
    yield* Deferred.succeed(publication, outcome);
  });

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

  const list = Effect.fn("ComputeResults.list")(function* (project: ResultsProject) {
    return yield* Effect.tryPromise({
      try: () => reader(project).list(),
      catch: resultsError("The results could not be read."),
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

  const publication = Effect.fn("ComputeResults.publication")(function* (
    sessionId: string,
    executionId: string,
  ) {
    const outcome = yield* Deferred.await(publicationFor(sessionId, executionId));
    if (outcome._tag === "failed") return outcome;
    return {
      _tag: "published" as const,
      summary: summarizeRevision(
        outcome.revision,
        outcome.revision.inputs.files
          .filter((input) => input.changedDuringRun)
          .map((input) => ({ kind: "input-changed-during-run" as const, path: input.path })),
      ),
    };
  });

  return ComputeResults.of({ resolve, list, figure, publication });
});

export const layer = Layer.effect(ComputeResults, make);
