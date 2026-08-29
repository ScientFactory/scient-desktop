// @effect-diagnostics nodeBuiltinImport:off -- The immutable PDF path is server-owned.
import type {
  ScientLatexBuildSnapshot,
  ScientLatexDiagnostic,
  ScientLatexPdfBuildDiagnostic,
  ScientLatexPdfBuildInput,
  ScientLatexPdfBuildResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as LatexBuildService from "../../../scient/latex/LatexBuildService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  commitStagedProjectPdfOutput,
  isInsideRoot,
  isWindowsAbsolutePath,
  type ProjectDocumentBuildBoundaryError,
  resolveDocumentBuildProject,
  resolveProjectPdfOutput,
  stageProjectPdfOutput,
} from "./projectDocumentBuild.ts";
import { ScientLatexBuildToolError } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientLatexBuildToolError>[0]["code"];

interface ResolvedLatexSource {
  readonly canonicalRoot: string;
  readonly sourcePath: string;
}

export interface ScientLatexBuildWaitOptions {
  readonly waitBudgetMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryAfterMs?: number;
}

const ACTIVE_BUILD_STATES = new Set(["queued", "running", "publishing"]);
const DEFAULT_WAIT_BUDGET_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RETRY_AFTER_MS = 1_500;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_FILE_LENGTH = 1_024;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2_048;
const MAX_INSTALLING_PACKAGES = 40;
const MAX_PACKAGE_NAME_LENGTH = 256;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;

const toolError = (
  code: ErrorCode,
  message: string,
  details?: Omit<ConstructorParameters<typeof ScientLatexBuildToolError>[0], "code" | "message">,
) =>
  new ScientLatexBuildToolError({
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH).trim() || "LaTeX build failed.",
    ...details,
  });

const boundaryToolError = (cause: ProjectDocumentBuildBoundaryError) =>
  toolError(cause.code, cause.message);

const boundedDiagnostics = (
  diagnostics: ReadonlyArray<ScientLatexDiagnostic>,
): ReadonlyArray<ScientLatexPdfBuildDiagnostic> =>
  [
    ...diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ...diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
  ]
    .slice(0, MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      ...diagnostic,
      file: diagnostic.file?.slice(0, MAX_DIAGNOSTIC_FILE_LENGTH) ?? null,
      message: diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    }));

const boundedInstallingPackages = (packages: ReadonlyArray<string>): ReadonlyArray<string> =>
  packages
    .slice(0, MAX_INSTALLING_PACKAGES)
    .map((packageName) => packageName.slice(0, MAX_PACKAGE_NAME_LENGTH).trim())
    .filter((packageName) => packageName.length > 0);

const isBuildActive = (snapshot: ScientLatexBuildSnapshot): boolean =>
  snapshot.pendingRerun || ACTIVE_BUILD_STATES.has(snapshot.state);

const sameRevision = (
  left: ScientLatexBuildSnapshot["descriptor"],
  right: ScientLatexBuildSnapshot["descriptor"],
): boolean =>
  left?._tag === "generated-pdf" &&
  right?._tag === "generated-pdf" &&
  left.authority === right.authority &&
  left.artifactId === right.artifactId &&
  left.revisionId === right.revisionId;

const resolveLatexSource = Effect.fn("ScientLatexBuild.resolveSource")(function* (
  root: string,
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    requestedPath.includes("\0") ||
    path.isAbsolute(requestedPath) ||
    isWindowsAbsolutePath(requestedPath)
  ) {
    return yield* toolError(
      "invalid-source-path",
      "sourcePath must be relative to the current Scient project.",
    );
  }
  const segments = requestedPath.split(/[\\/]/u);
  if (
    segments.some((segment) => segment === "..") ||
    path.extname(requestedPath).toLowerCase() !== ".tex"
  ) {
    return yield* toolError(
      "invalid-source-path",
      "sourcePath must identify a project-relative .tex file.",
    );
  }

  const canonicalRoot = yield* fileSystem
    .realPath(root)
    .pipe(
      Effect.mapError(() =>
        toolError("project-changed", "The current project workspace is unavailable."),
      ),
    );
  const candidatePath = path.resolve(canonicalRoot, requestedPath);
  const canonicalPath = yield* fileSystem
    .realPath(candidatePath)
    .pipe(
      Effect.mapError(() =>
        toolError("source-not-found", "The LaTeX source file was not found in this project."),
      ),
    );
  if (!isInsideRoot(canonicalRoot, canonicalPath, path) || canonicalPath === canonicalRoot) {
    return yield* toolError(
      "invalid-source-path",
      "The LaTeX source must remain inside the current project workspace.",
    );
  }
  const info = yield* fileSystem
    .stat(canonicalPath)
    .pipe(
      Effect.mapError(() =>
        toolError("source-not-found", "The LaTeX source file could not be inspected."),
      ),
    );
  if (info.type !== "File") {
    return yield* toolError("source-not-found", "The LaTeX source path does not identify a file.");
  }
  return {
    canonicalRoot,
    sourcePath: path.relative(canonicalRoot, canonicalPath).split(path.sep).join("/"),
  } satisfies ResolvedLatexSource;
});

const buildServiceToolError = (
  cause: LatexBuildService.LatexBuildError,
  input: ScientLatexPdfBuildInput,
) =>
  toolError("invalid-source-path", cause.detail, {
    sourcePath: input.sourcePath,
    outputPath: input.outputPath,
  });

const inProgressResult = (input: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly snapshot: ScientLatexBuildSnapshot;
  readonly retryAfterMs: number;
}): ScientLatexPdfBuildResult => ({
  status: "in-progress",
  sourcePath: input.sourcePath,
  rootSourcePath: input.snapshot.rootRelativePath,
  outputPath: input.outputPath,
  buildState: input.snapshot.state,
  toolchain: input.snapshot.toolchain,
  installingPackages: boundedInstallingPackages(input.snapshot.installingPackages ?? []),
  retryAfterMs: input.retryAfterMs,
});

const failFromSnapshot = (
  input: ScientLatexPdfBuildInput,
  sourcePath: string,
  snapshot: ScientLatexBuildSnapshot,
) => {
  const diagnostics = boundedDiagnostics(snapshot.diagnostics);
  const details = {
    sourcePath,
    rootSourcePath: snapshot.rootRelativePath,
    outputPath: input.outputPath,
    diagnostics,
    toolchain: snapshot.toolchain,
  } as const;
  if (snapshot.state === "cancelled") {
    return toolError(
      "build-cancelled",
      snapshot.failureSummary ?? "The LaTeX build was cancelled.",
      details,
    );
  }
  if (
    snapshot.toolchain === null ||
    snapshot.toolchain.kind === null ||
    snapshot.failureSummary?.startsWith("No LaTeX toolchain found") === true
  ) {
    return toolError(
      "toolchain-unavailable",
      "No LaTeX toolchain is available. Open the .tex file in Scient, install Scient's managed LaTeX runtime, then retry this build.",
      details,
    );
  }
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return toolError(
    "build-failed",
    snapshot.failureSummary ?? firstError?.message ?? "The LaTeX build failed.",
    details,
  );
};

const presentLatexDocument = Effect.fn("ScientLatexBuild.present")(function* (
  invocation: McpInvocationScope,
  rootSourcePath: string,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker
    .invoke({
      scope: invocation,
      operation: "documentLatexPresent",
      input: { rootSourcePath },
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("generated LaTeX document could not be presented", {
          errorTag: cause._tag,
        }).pipe(Effect.as(false)),
      ),
    );
});

export const buildScientLatexForInvocation = Effect.fn("ScientLatexBuild.build")(function* (
  input: ScientLatexPdfBuildInput,
  options: ScientLatexBuildWaitOptions = {},
) {
  const waitBudgetMs = Math.max(0, options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const retryAfterMs = Math.max(250, options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
  const { invocation, root } = yield* resolveDocumentBuildProject().pipe(
    Effect.mapError(boundaryToolError),
  );
  const latexSource = yield* resolveLatexSource(root, input.sourcePath);
  const output = yield* resolveProjectPdfOutput(latexSource.canonicalRoot, input.outputPath).pipe(
    Effect.mapError(boundaryToolError),
  );
  const builds = yield* LatexBuildService.LatexBuildService;
  const generatedDocuments = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const buildInput = {
    workspaceRoot: latexSource.canonicalRoot,
    relativePath: latexSource.sourcePath,
  } as const;
  const deadline = (yield* Clock.currentTimeMillis) + waitBudgetMs;
  let snapshot = yield* builds
    .status(buildInput)
    .pipe(Effect.mapError((cause) => buildServiceToolError(cause, input)));
  if (!isBuildActive(snapshot) && snapshot.state !== "succeeded") {
    snapshot = yield* builds
      .requestBuild(buildInput)
      .pipe(Effect.mapError((cause) => buildServiceToolError(cause, input)));
  }

  while (true) {
    while (isBuildActive(snapshot)) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        return inProgressResult({
          sourcePath: latexSource.sourcePath,
          outputPath: output.outputPath,
          snapshot,
          retryAfterMs,
        });
      }
      yield* Effect.sleep(Duration.millis(Math.min(pollIntervalMs, deadline - now)));
      snapshot = yield* builds
        .status(buildInput)
        .pipe(Effect.mapError((cause) => buildServiceToolError(cause, input)));
    }

    if (snapshot.state !== "succeeded") {
      return yield* failFromSnapshot(input, latexSource.sourcePath, snapshot);
    }
    if (snapshot.descriptor?._tag !== "generated-pdf") {
      return yield* toolError(
        "revision-unavailable",
        "The LaTeX build succeeded without an available immutable PDF revision.",
        {
          sourcePath: latexSource.sourcePath,
          rootSourcePath: snapshot.rootRelativePath,
          outputPath: output.outputPath,
          diagnostics: boundedDiagnostics(snapshot.diagnostics),
          toolchain: snapshot.toolchain,
        },
      );
    }
    if (
      snapshot.descriptor.pageCount === undefined ||
      snapshot.toolchain === null ||
      snapshot.toolchain.kind === null
    ) {
      return yield* toolError(
        "revision-unavailable",
        "The completed LaTeX build is missing required validation or toolchain evidence.",
        {
          sourcePath: latexSource.sourcePath,
          rootSourcePath: snapshot.rootRelativePath,
          outputPath: output.outputPath,
          diagnostics: boundedDiagnostics(snapshot.diagnostics),
          toolchain: snapshot.toolchain,
          publishedSource: snapshot.descriptor,
        },
      );
    }
    const successfulPageCount = snapshot.descriptor.pageCount;
    const successfulToolchain = snapshot.toolchain;
    const successfulSnapshot = snapshot;
    const materialized = yield* Effect.scoped(
      Effect.gen(function* () {
        const source = successfulSnapshot.descriptor;
        if (source?._tag !== "generated-pdf") {
          return yield* toolError(
            "revision-unavailable",
            "The LaTeX PDF revision is no longer available.",
          );
        }
        yield* generatedDocuments.retainRevision({
          artifactId: source.artifactId,
          revisionId: source.revisionId,
        });
        const revision = yield* generatedDocuments
          .resolveRevision({
            authority: source.authority,
            artifactId: source.artifactId,
            revisionId: source.revisionId,
          })
          .pipe(
            Effect.mapError(() =>
              toolError(
                "revision-unavailable",
                "Scient could not resolve the validated LaTeX PDF revision.",
                {
                  sourcePath: latexSource.sourcePath,
                  rootSourcePath: successfulSnapshot.rootRelativePath,
                  outputPath: output.outputPath,
                  publishedSource: source,
                },
              ),
            ),
          );
        const bytes = yield* fileSystem.readFile(revision.path).pipe(
          Effect.mapError(() =>
            toolError(
              "revision-unavailable",
              "Scient could not read the validated LaTeX PDF revision.",
              {
                sourcePath: latexSource.sourcePath,
                rootSourcePath: successfulSnapshot.rootRelativePath,
                outputPath: output.outputPath,
                publishedSource: source,
              },
            ),
          ),
        );
        const staged = yield* stageProjectPdfOutput(output, bytes).pipe(
          Effect.mapError(() =>
            toolError(
              "partial-publication",
              "Scient retained the immutable LaTeX PDF, but could not stage the requested project file.",
              {
                sourcePath: latexSource.sourcePath,
                rootSourcePath: successfulSnapshot.rootRelativePath,
                outputPath: output.outputPath,
                publishedSource: source,
              },
            ),
          ),
        );
        const latest = yield* builds
          .status(buildInput)
          .pipe(Effect.mapError((cause) => buildServiceToolError(cause, input)));
        if (
          latest.state !== "succeeded" ||
          latest.pendingRerun ||
          !sameRevision(successfulSnapshot.descriptor, latest.descriptor)
        ) {
          return { _tag: "changed" as const, snapshot: latest };
        }
        yield* commitStagedProjectPdfOutput(staged).pipe(
          Effect.mapError(() =>
            toolError(
              "partial-publication",
              "Scient retained the immutable LaTeX PDF, but could not write the requested project file.",
              {
                sourcePath: latexSource.sourcePath,
                rootSourcePath: successfulSnapshot.rootRelativePath,
                outputPath: output.outputPath,
                publishedSource: source,
              },
            ),
          ),
        );
        return {
          _tag: "written" as const,
          source,
          title: revision.title,
          byteLength: bytes.byteLength,
        };
      }),
    );

    if (materialized._tag === "changed") {
      snapshot = materialized.snapshot;
      if (!isBuildActive(snapshot) && snapshot.state === "succeeded") continue;
      const now = yield* Clock.currentTimeMillis;
      if (isBuildActive(snapshot) && now >= deadline) {
        return inProgressResult({
          sourcePath: latexSource.sourcePath,
          outputPath: output.outputPath,
          snapshot,
          retryAfterMs,
        });
      }
      continue;
    }

    const presented = yield* presentLatexDocument(invocation, successfulSnapshot.rootRelativePath);
    return {
      status: "completed",
      sourcePath: latexSource.sourcePath,
      rootSourcePath: successfulSnapshot.rootRelativePath,
      outputPath: output.outputPath,
      source: materialized.source,
      title: materialized.title,
      pageCount: successfulPageCount,
      byteLength: materialized.byteLength,
      diagnostics: boundedDiagnostics(successfulSnapshot.diagnostics),
      warnings: presented ? [] : ["presentation-unavailable"],
      toolchain: successfulToolchain,
      validation: "structural",
      visualReviewPerformed: false,
    } satisfies ScientLatexPdfBuildResult;
  }
});
