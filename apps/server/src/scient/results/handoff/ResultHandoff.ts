// @effect-diagnostics nodeBuiltinImport:off -- chosen destinations and runtime paths are host paths.
import * as NodePath from "node:path";

import {
  ComputeLanguageId,
  ComputeResultsError,
  ComputeSessionId,
  type ResultHandoffExportInput,
  type ResultHandoffExportProgress,
  type ComputeResultRevisionId,
  type ResultHandoffVerifyRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import packageJson from "../../../../package.json" with { type: "json" };
import type { ComputeRpcGateway } from "../../compute/ComputeRpcGateway.ts";
import type { ComputeSessionService } from "../../compute/ComputeSessionService.ts";
import type { ExecutionProcess } from "../../execution/LocalExecutionProcess.ts";
import { makeResultsReader, type ResultsLayout } from "../resultRevisions.ts";
import { exportResultPackage } from "./exportResultPackage.ts";
import { handoffLockfileChoices } from "./handoffEnvironment.ts";
import { handoffInputChoices } from "./handoffInputs.ts";
import { isHandoffRefusal, relativeInputPath } from "./handoffFiles.ts";
import { verifyResultPackage } from "./verifyResultPackage.ts";

const failure = (message: string) => (cause: unknown) =>
  isHandoffRefusal(cause)
    ? new ComputeResultsError({ message: cause.message })
    : new ComputeResultsError({ message, cause });

type RevisionSelection = {
  readonly cwd: string;
  readonly revision?: ComputeResultRevisionId;
  readonly path?: string;
};

export function makeResultHandoff(options: {
  readonly layout: ResultsLayout;
  readonly process: ExecutionProcess["Service"];
  readonly gateway: Pick<ComputeRpcGateway, "project" | "inspectRuntimes">;
  readonly compute: Pick<ComputeSessionService["Service"], "listExecutions">;
}) {
  const verifications = new Map<string, Deferred.Deferred<void>>();
  const exports = new Map<string, { current: ResultHandoffExportProgress | null }>();

  const readRevision = Effect.fn("ResultHandoff.readRevision")(function* (
    input: RevisionSelection,
  ) {
    if (input.revision === undefined && input.path === undefined) {
      return yield* new ComputeResultsError({
        message: "Pass a script or notebook path, or a revision ID from scient_results_list.",
      });
    }
    const project = yield* options.gateway
      .project({ cwd: input.cwd })
      .pipe(Effect.mapError(failure("The project could not be opened.")));
    const reader = makeResultsReader(options.layout, project.projectId, project.root);
    const revision = yield* Effect.tryPromise({
      try: async () => {
        const path = input.path === undefined ? undefined : relativeInputPath(input.path);
        return (await reader.revisions()).find(
          (item) =>
            (path === undefined || item.script.path === path) &&
            (input.revision === undefined || item.revision === input.revision),
        );
      },
      catch: failure("The saved result could not be read."),
    });
    if (revision === undefined) {
      return yield* new ComputeResultsError({
        message: "No saved result matches. Find revision IDs with scient_results_list.",
      });
    }
    return { project, reader, revision };
  });

  const choices = Effect.fn("ResultHandoff.choices")(function* (input: RevisionSelection) {
    const { revision, project } = yield* readRevision(input);
    return yield* Effect.tryPromise({
      try: async () => {
        const [files, lockfiles] = await Promise.all([
          handoffInputChoices(project.root, revision),
          handoffLockfileChoices(project.root, revision),
        ]);
        return { ...files, lockfiles };
      },
      catch: failure("The recorded inputs could not be read."),
    });
  });

  const exportPackage = Effect.fn("ResultHandoff.export")(function* (
    input: Omit<ResultHandoffExportInput, "revision"> & RevisionSelection,
  ) {
    if (!NodePath.isAbsolute(input.destination)) {
      return yield* new ComputeResultsError({
        message: "Choose an absolute path to a folder on the Compute computer.",
      });
    }
    const { project, reader, revision } = yield* readRevision(input);
    const history = yield* options.compute
      .listExecutions({
        projectId: project.projectId,
        sessionId: ComputeSessionId.make(revision.run.sessionId),
      })
      .pipe(Effect.orElseSucceed(() => []));
    const end = history.findLastIndex(
      (entry) => entry.request.executionId === revision.run.executionId,
    );
    const recorded = history[end];
    const recordedScript = revision.script.kind === "notebook" ? undefined : recorded?.request.code;
    const recordedCells =
      recorded === undefined || revision.script.kind !== "notebook"
        ? undefined
        : history.slice(0, end + 1).flatMap(({ request, result }) => {
            const { source } = request;
            return request.generation === recorded.request.generation &&
              result?.status === "succeeded" &&
              source._tag === "document" &&
              source.origin === "cell" &&
              source.path === revision.script.path
              ? [request.code]
              : [];
          });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const entry: { current: ResultHandoffExportProgress | null } = { current: null };
    const id = input.progressId;
    if (id !== undefined) {
      if (exports.has(id))
        return yield* new ComputeResultsError({ message: "This export is already running." });
      exports.set(id, entry);
    }
    return yield* Effect.tryPromise({
      try: (signal) =>
        exportResultPackage({
          signal,
          onProgress: (progress) => {
            entry.current = progress;
          },
          reader,
          revision,
          projectRoot: project.root,
          destination: input.destination,
          includeInputs: input.includeInputs,
          ...(input.excludeLockfiles === undefined
            ? {}
            : { excludeLockfiles: input.excludeLockfiles }),
          createdAt,
          scientVersion: packageJson.version,
          ...(recordedScript === undefined ? {} : { recordedScript }),
          ...(recordedCells === undefined ? {} : { recordedCells }),
        }),
      catch: failure(
        "The result package could not be saved. Check the destination and files, then try again.",
      ),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (id !== undefined) exports.delete(id);
        }),
      ),
    );
  });

  const exportProgress = Effect.fn("ResultHandoff.exportProgress")(function* (input: {
    readonly progressId: string;
  }) {
    return yield* Effect.sync(() => exports.get(input.progressId)?.current ?? null);
  });

  const selectExecutable = (language: string) =>
    language.toLowerCase() !== "python"
      ? Effect.undefined
      : options.gateway
          .inspectRuntimes({
            cwd: null,
            languageIds: [ComputeLanguageId.make("python")],
            refresh: false,
          })
          .pipe(
            Effect.map((result) => result.languages[0]?.selection?.executable ?? undefined),
            Effect.orElseSucceed(() => undefined),
          );

  const verify = Effect.fn("ResultHandoff.verify")(function* (input: ResultHandoffVerifyRequest) {
    const id = input.verificationId;
    const cancellation = yield* Deferred.make<void>();
    if (id !== undefined) {
      if (verifications.has(id))
        return yield* new ComputeResultsError({ message: "This verification is already running." });
      verifications.set(id, cancellation);
    }
    const finish = Effect.sync(() => {
      if (id !== undefined && verifications.get(id) === cancellation) verifications.delete(id);
    });
    return yield* verifyResultPackage(options.process, input, selectExecutable, {
      cancellation,
      finish,
    }).pipe(
      Effect.mapError(
        failure("Verification could not be saved. Check the package folder and its parent."),
      ),
      Effect.ensuring(finish),
    );
  });

  const cancelVerification = Effect.fn("ResultHandoff.cancelVerification")(function* (input: {
    readonly verificationId: string;
  }) {
    const cancellation = verifications.get(input.verificationId);
    if (cancellation === undefined) return { requested: false };
    yield* Deferred.succeed(cancellation, undefined);
    return { requested: true };
  });

  return { choices, exportPackage, exportProgress, verify, cancelVerification };
}

export type ResultHandoff = ReturnType<typeof makeResultHandoff>;
