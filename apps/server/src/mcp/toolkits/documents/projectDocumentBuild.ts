import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  WorkspaceBindingId,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingRecordV1,
} from "../../../scient/projectScope/WorkspaceBinding.ts";
import * as WorkspaceBindingResolver from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";

const NonEmptyMessage = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

export class ProjectDocumentBuildBoundaryError extends Schema.TaggedError<ProjectDocumentBuildBoundaryError>()(
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
  readonly invocation: AgentInvocationContext.AgentInvocationScope;
  readonly root: string;
  readonly bindingId: WorkspaceBindingId;
  readonly authorityGeneration: WorkspaceBindingRecordV1["authorityGeneration"];
  readonly scopeRevision: WorkspaceAuthorityScopeRevision;
}

export interface ResolvedPdfOutput {
  readonly absolutePath: string;
  readonly canonicalRoot: string;
  readonly outputPath: string;
}

export interface StagedPdfOutput {
  readonly canonicalRoot: string;
  readonly canonicalTargetDirectory: string;
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
    const invocation = yield* AgentInvocationContext.AgentInvocationContext;
    if (!invocation.capabilities.has("documents:build")) {
      return yield* boundaryError(
        "capability-unavailable",
        "This provider session does not grant document build access.",
      );
    }
    const resolved = yield* consumeAgentWorkspace().pipe(
      Effect.mapError((cause) => boundaryError(cause.code, cause.message)),
    );
    const binding = resolved.binding;
    return {
      invocation,
      root: binding.canonicalRoot,
      bindingId: binding.bindingId,
      authorityGeneration: binding.authorityGeneration,
      scopeRevision: resolved.scopeRevision,
    } satisfies ResolvedDocumentBuildProject;
  },
);

export const assertCurrentDocumentBuildProject = Effect.fn(
  "ProjectDocumentBuild.assertCurrentProject",
)(function* (authority: ResolvedDocumentBuildProject) {
  const resolver = yield* WorkspaceBindingResolver.WorkspaceBindingResolver;
  yield* resolver
    .assertCurrentThreadScope({
      threadId: authority.invocation.threadId,
      bindingId: authority.bindingId,
      authorityGeneration: authority.authorityGeneration,
      scopeRevision: authority.scopeRevision,
    })
    .pipe(
      Effect.mapError(() =>
        boundaryError(
          "project-changed",
          "The active project workspace changed while the document was being built. Run the build again.",
        ),
      ),
    );
});

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

  const temporaryDirectory = yield* Effect.acquireRelease(
    fileSystem
      .makeTempDirectory({
        directory: canonicalTargetDirectory,
        prefix: `.${path.basename(output.absolutePath)}.`,
      })
      .pipe(Effect.mapError(writeError)),
    (directory) =>
      Effect.gen(function* () {
        const currentParent = yield* fileSystem
          .realPath(path.dirname(directory))
          .pipe(Effect.option);
        if (Option.isNone(currentParent) || currentParent.value !== canonicalTargetDirectory) {
          return;
        }
        const currentDirectory = yield* fileSystem.realPath(directory).pipe(Effect.option);
        if (
          Option.isNone(currentDirectory) ||
          currentDirectory.value === canonicalTargetDirectory ||
          !isInsideRoot(canonicalTargetDirectory, currentDirectory.value, path)
        ) {
          return;
        }
        yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
      }),
  );
  const temporaryPath = path.join(temporaryDirectory, "document.pdf");
  yield* fileSystem.writeFile(temporaryPath, bytes).pipe(Effect.mapError(writeError));
  yield* Effect.scoped(
    fileSystem.open(temporaryPath, { flag: "r+" }).pipe(Effect.flatMap((file) => file.sync)),
  ).pipe(Effect.mapError(writeError));

  return {
    canonicalRoot: output.canonicalRoot,
    canonicalTargetDirectory,
    finalPath,
    temporaryPath,
  } satisfies StagedPdfOutput;
});

export const commitStagedProjectPdfOutput = Effect.fn("ProjectDocumentBuild.commitStagedPdfOutput")(
  function* (staged: StagedPdfOutput) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const writeError = () =>
      boundaryError(
        "output-write-failed",
        "Scient validated the PDF but could not write it to the requested project path.",
      );
    const currentTargetDirectory = yield* fileSystem
      .realPath(path.dirname(staged.finalPath))
      .pipe(Effect.mapError(writeError));
    const currentTemporaryPath = yield* fileSystem
      .realPath(staged.temporaryPath)
      .pipe(Effect.mapError(writeError));
    if (
      currentTargetDirectory !== staged.canonicalTargetDirectory ||
      currentTemporaryPath !== staged.temporaryPath ||
      !isInsideRoot(staged.canonicalRoot, currentTargetDirectory, path) ||
      !isInsideRoot(staged.canonicalTargetDirectory, currentTemporaryPath, path)
    ) {
      return yield* boundaryError(
        "invalid-output-path",
        "The PDF output directory changed before the project file could be written.",
      );
    }
    const existingOutput = yield* fileSystem.stat(staged.finalPath).pipe(Effect.option);
    if (Option.isSome(existingOutput) && existingOutput.value.type !== "File") {
      return yield* writeError();
    }
    yield* fileSystem
      .rename(staged.temporaryPath, staged.finalPath)
      .pipe(Effect.mapError(writeError));
  },
);
