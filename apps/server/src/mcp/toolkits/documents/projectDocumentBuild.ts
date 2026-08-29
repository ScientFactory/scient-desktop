import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const NonEmptyMessage = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

export class ProjectDocumentBuildBoundaryError extends Schema.TaggedErrorClass<ProjectDocumentBuildBoundaryError>()(
  "ProjectDocumentBuildBoundaryError",
  {
    code: Schema.Literals([
      "capability-unavailable",
      "project-required",
      "project-changed",
      "invalid-output-path",
      "output-write-failed",
    ]),
    message: NonEmptyMessage,
  },
) {}

export interface ResolvedDocumentBuildProject {
  readonly invocation: McpInvocationContext.McpInvocationScope;
  readonly root: string;
}

export interface ResolvedPdfOutput {
  readonly absolutePath: string;
  readonly canonicalRoot: string;
  readonly outputPath: string;
}

export interface StagedPdfOutput {
  readonly finalPath: string;
  readonly temporaryPath: string;
}

const boundaryError = (code: ProjectDocumentBuildBoundaryError["code"], message: string) =>
  new ProjectDocumentBuildBoundaryError({ code, message });

export const isWindowsAbsolutePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

export const isInsideRoot = (root: string, candidate: string, path: Path.Path): boolean => {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
};

export const resolveDocumentBuildProject = Effect.fn("ProjectDocumentBuild.resolveProject")(
  function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("documents:build")) {
      return yield* boundaryError(
        "capability-unavailable",
        "This provider session does not grant document build access.",
      );
    }
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(
        Effect.mapError(() =>
          boundaryError("project-changed", "The current thread could not be resolved."),
        ),
      );
    if (Option.isNone(thread) || thread.value.projectId === null) {
      return yield* boundaryError(
        "project-required",
        "Document builds require a thread that belongs to a Scient project.",
      );
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(() =>
          boundaryError("project-changed", "The current project could not be resolved."),
        ),
      );
    if (Option.isNone(project)) {
      return yield* boundaryError(
        "project-changed",
        "The project for this thread is no longer active.",
      );
    }
    return {
      invocation,
      root: thread.value.worktreePath ?? project.value.workspaceRoot,
    } satisfies ResolvedDocumentBuildProject;
  },
);

export const resolveProjectPdfOutput = Effect.fn("ProjectDocumentBuild.resolvePdfOutput")(
  function* (root: string, requestedPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      requestedPath.includes("\0") ||
      path.isAbsolute(requestedPath) ||
      isWindowsAbsolutePath(requestedPath)
    ) {
      return yield* boundaryError(
        "invalid-output-path",
        "outputPath must be relative to the current Scient project.",
      );
    }
    const segments = requestedPath.split(/[\\/]/u);
    if (
      segments.some((segment) => segment === "..") ||
      path.extname(requestedPath).toLowerCase() !== ".pdf"
    ) {
      return yield* boundaryError(
        "invalid-output-path",
        "outputPath must identify a project-relative .pdf file.",
      );
    }

    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() =>
          boundaryError("project-changed", "The current project workspace is unavailable."),
        ),
      );
    const absolutePath = path.resolve(canonicalRoot, requestedPath);
    if (!isInsideRoot(canonicalRoot, absolutePath, path) || absolutePath === canonicalRoot) {
      return yield* boundaryError(
        "invalid-output-path",
        "The PDF output must remain inside the current project workspace.",
      );
    }

    const existingOutput = yield* fileSystem.stat(absolutePath).pipe(Effect.option);
    if (Option.isSome(existingOutput) && existingOutput.value.type !== "File") {
      return yield* boundaryError(
        "invalid-output-path",
        "The PDF output path must identify a file, not an existing directory or special entry.",
      );
    }

    let existingAncestor = path.dirname(absolutePath);
    while (true) {
      const canonicalAncestor = yield* fileSystem.realPath(existingAncestor).pipe(Effect.option);
      if (Option.isSome(canonicalAncestor)) {
        if (!isInsideRoot(canonicalRoot, canonicalAncestor.value, path)) {
          return yield* boundaryError(
            "invalid-output-path",
            "The PDF output must remain inside the current project workspace.",
          );
        }
        break;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return yield* boundaryError(
          "invalid-output-path",
          "Scient could not resolve the PDF output directory inside this project.",
        );
      }
      existingAncestor = parent;
    }

    return {
      absolutePath,
      canonicalRoot,
      outputPath: path.relative(canonicalRoot, absolutePath).split(path.sep).join("/"),
    } satisfies ResolvedPdfOutput;
  },
);

export const stageProjectPdfOutput = Effect.fn("ProjectDocumentBuild.stagePdfOutput")(function* (
  output: ResolvedPdfOutput,
  bytes: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetDirectory = path.dirname(output.absolutePath);
  const writeError = () =>
    boundaryError(
      "output-write-failed",
      "Scient validated the PDF but could not write it to the requested project path.",
    );

  yield* fileSystem
    .makeDirectory(targetDirectory, { recursive: true })
    .pipe(Effect.mapError(writeError));
  const canonicalTargetDirectory = yield* fileSystem
    .realPath(targetDirectory)
    .pipe(Effect.mapError(writeError));
  if (!isInsideRoot(output.canonicalRoot, canonicalTargetDirectory, path)) {
    return yield* boundaryError(
      "invalid-output-path",
      "The PDF output directory no longer belongs to the current project.",
    );
  }

  const finalPath = path.join(canonicalTargetDirectory, path.basename(output.absolutePath));
  const existingOutput = yield* fileSystem.stat(finalPath).pipe(Effect.option);
  if (Option.isSome(existingOutput) && existingOutput.value.type !== "File") {
    return yield* writeError();
  }

  const temporaryDirectory = yield* fileSystem
    .makeTempDirectoryScoped({
      directory: canonicalTargetDirectory,
      prefix: `.${path.basename(output.absolutePath)}.`,
    })
    .pipe(Effect.mapError(writeError));
  const temporaryPath = path.join(temporaryDirectory, "document.pdf");
  yield* fileSystem.writeFile(temporaryPath, bytes).pipe(Effect.mapError(writeError));
  yield* Effect.scoped(
    fileSystem.open(temporaryPath, { flag: "r+" }).pipe(Effect.flatMap((file) => file.sync)),
  ).pipe(Effect.mapError(writeError));

  return { finalPath, temporaryPath } satisfies StagedPdfOutput;
});

export const commitStagedProjectPdfOutput = Effect.fn("ProjectDocumentBuild.commitStagedPdfOutput")(
  function* (staged: StagedPdfOutput) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .rename(staged.temporaryPath, staged.finalPath)
      .pipe(
        Effect.mapError(() =>
          boundaryError(
            "output-write-failed",
            "Scient validated the PDF but could not write it to the requested project path.",
          ),
        ),
      );
  },
);
