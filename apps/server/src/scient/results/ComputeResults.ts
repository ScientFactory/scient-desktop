// @effect-diagnostics nodeBuiltinImport:off -- a placed figure is copied into the project with Node.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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
  sha256File,
  summarizeRevision,
  type PublishOutcome,
  type ResultsLayout,
} from "./resultRevisions.ts";

export interface ResultsProject {
  readonly projectId: string;
  readonly root: string;
}

const MAXIMUM_REMEMBERED_PUBLICATIONS = 200;

const resultsError = (message: string) => (cause: unknown) =>
  new ComputeResultsError({ message, cause });

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
    /** Copies a revision's figure beside the manuscript and returns its path from there. */
    readonly placeFigure: (
      project: ResultsProject,
      input: { readonly documentPath: string; readonly revision: string; readonly output: string },
    ) => Effect.Effect<string, ComputeResultsError>;
    /** What publishing the run's results came to, once the run has settled. */
    readonly publication: (
      executionId: string,
    ) => Effect.Effect<
      | { readonly _tag: "published"; readonly summary: ComputeResultSummary }
      | { readonly _tag: "failed"; readonly message: string }
    >;
  }
>()("t3/scient/results/ComputeResults") {}

function insideProject(root: string, relativePath: string): string | null {
  const resolved = NodePath.resolve(root, ...relativePath.split("/"));
  return resolved.startsWith(`${root}${NodePath.sep}`) ? resolved : null;
}

async function placeFigureFile(
  root: string,
  source: { readonly path: string; readonly sha256: string },
  documentPath: string,
  revision: string,
  output: string,
): Promise<string> {
  const document = insideProject(root, documentPath);
  if (document === null) throw new Error("The manuscript is outside this project.");
  const extension = NodePath.extname(output);
  const stem = NodePath.basename(output, extension).replace(/[^\p{L}\p{N}._-]+/gu, "-") || "figure";
  const folder = NodePath.join(NodePath.dirname(document), "assets", "results");
  await NodeFSP.mkdir(folder, { recursive: true });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = `${stem}-${revision}${attempt === 1 ? "" : `-${attempt}`}${extension}`;
    const target = NodePath.join(folder, name);
    const relative = `assets/results/${name}`;
    try {
      await NodeFSP.copyFile(source.path, target, NodeFSP.constants.COPYFILE_EXCL);
      return relative;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if ((await sha256File(target)) === source.sha256) return relative;
    }
  }
  throw new Error("Too many files already use this figure's name.");
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const compute = yield* ComputeSessionService.ComputeSessionService;
  const layout: ResultsLayout = { computeDir: config.computeDir };
  const publications = new Map<string, Deferred.Deferred<PublishOutcome>>();
  const publicationFor = (executionId: string) => {
    const existing = publications.get(executionId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<PublishOutcome>();
    publications.set(executionId, created);
    if (publications.size > MAXIMUM_REMEMBERED_PUBLICATIONS)
      publications.delete(publications.keys().next().value!);
    return created;
  };

  const publishSettled = Effect.fn("ComputeResults.publishSettled")(function* (
    settled: ComputeSessionService.ComputeSettledRun,
  ) {
    const { request, result } = settled.execution;
    const source = request.source;
    if (source._tag !== "document" || source.origin !== "file" || result === null) return;
    const stagingFolder = computeResultsStagingFolder(
      config.computeDir,
      settled.projectId,
      request.executionId,
    );
    if (stagingFolder === null) return;
    const staged = yield* Effect.promise(() =>
      NodeFSP.stat(stagingFolder).then(
        (status) => status.isDirectory(),
        () => false,
      ),
    );
    if (!staged) {
      const waiting = publications.get(request.executionId);
      if (waiting !== undefined)
        yield* Deferred.succeed(waiting, {
          _tag: "failed",
          message: "The run had no results folder, so no results were published.",
        });
      return;
    }
    const session = yield* compute
      .getSession({ projectId: settled.projectId, sessionId: request.sessionId })
      .pipe(Effect.orElseSucceed(() => null));
    const outcome = yield* Effect.tryPromise({
      try: () =>
        publishScriptRun(layout, {
          projectId: settled.projectId,
          root: settled.root,
          stagingFolder,
          succeeded: result.status === "succeeded",
          scriptPath: source.path,
          languageId: session?.languageId ?? "unknown",
          code: request.code,
          sessionId: request.sessionId,
          executionId: request.executionId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt ?? request.submittedAt,
          threadId: request.actor?.threadId,
          runtime: {
            executable: session?.runtime?.executable ?? null,
            version:
              session?.identity?.languageVersion ?? session?.runtime?.languageVersion ?? null,
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
    yield* Deferred.succeed(publicationFor(request.executionId), outcome);
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

  const placeFigure = Effect.fn("ComputeResults.placeFigure")(function* (
    project: ResultsProject,
    input: { readonly documentPath: string; readonly revision: string; readonly output: string },
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const figure = await reader(project).figure(input.revision, input.output);
        if (figure === null)
          throw new Error("This revision's figure is no longer stored. Re-run the script.");
        return placeFigureFile(
          project.root,
          figure,
          input.documentPath,
          input.revision,
          input.output,
        );
      },
      catch: (cause) =>
        new ComputeResultsError({
          message: cause instanceof Error ? cause.message : "The figure could not be placed.",
          cause,
        }),
    });
  });

  const publication = Effect.fn("ComputeResults.publication")(function* (executionId: string) {
    const outcome = yield* Deferred.await(publicationFor(executionId));
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

  return ComputeResults.of({ resolve, list, placeFigure, publication });
});

export const layer = Layer.effect(ComputeResults, make);
