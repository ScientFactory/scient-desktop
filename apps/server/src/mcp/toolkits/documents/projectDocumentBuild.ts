import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProjectFilePublicationOutcome } from "@t3tools/contracts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { inspectGuardedFile } from "../../../scient/workspace/RetainedFileMutation.ts";

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
      "project-required",
      "project-changed",
      "invalid-output-path",
      "output-write-failed",
    ]),
    message: NonEmptyMessage,
    publicationOutcome: Schema.optional(ProjectFilePublicationOutcome),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
    mutationId: Schema.optional(Schema.String),
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
  readonly expectedRevision: string | null;
}

export interface ProjectPdfOutputIntent {
  readonly output: ResolvedPdfOutput;
  readonly bytes: Uint8Array;
  readonly mutationId: string;
  readonly expectedMutationEpoch: string;
}

const boundaryError = (code: ProjectDocumentBuildBoundaryError["code"], message: string) =>
  new ProjectDocumentBuildBoundaryError({ code, message });

const isWindowsAbsolutePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

const isInsideRoot = (root: string, candidate: string, path: Path.Path): boolean => {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
};

/** The path inside `root` as `/`-separated project-relative text, or undefined outside it. */
const relativeInside = (root: string, candidate: string, path: Path.Path): string | undefined =>
  isInsideRoot(root, candidate, path) && path.relative(root, candidate) !== ""
    ? path.relative(root, candidate).split(path.sep).join("/")
    : undefined;

/**
 * Project-relative text for a requested path, or undefined outside the project. An absolute path
 * is compared with the root as bound and as resolved (macOS `/var` is `/private/var`) through its
 * nearest existing ancestor; the components after it stay as written, so a link stays the link.
 */
export const projectRelativePath = Effect.fn("ProjectDocumentBuild.projectRelativePath")(function* (
  roots: ReadonlyArray<string>,
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (requestedPath.includes("\0")) return undefined;
  if (!path.isAbsolute(requestedPath))
    return isWindowsAbsolutePath(requestedPath) ? undefined : requestedPath;
  for (const root of roots) {
    const relative = relativeInside(root, requestedPath, path);
    if (relative !== undefined) return relative;
  }
  let ancestor = path.dirname(requestedPath);
  let canonicalAncestor = yield* fileSystem.realPath(ancestor).pipe(Effect.option);
  while (Option.isNone(canonicalAncestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) return undefined;
    ancestor = next;
    canonicalAncestor = yield* fileSystem.realPath(ancestor).pipe(Effect.option);
  }
  const resolved = path.join(canonicalAncestor.value, path.relative(ancestor, requestedPath));
  for (const root of roots) {
    const relative = relativeInside(root, resolved, path);
    if (relative !== undefined) return relative;
  }
  return undefined;
});

export class ProjectDocumentSourceError extends Schema.TaggedError<ProjectDocumentSourceError>()(
  "ProjectDocumentSourceError",
  {
    code: Schema.Literals(["project-changed", "invalid-source-path", "source-not-found"]),
    message: NonEmptyMessage,
  },
) {}

export interface ResolvedProjectSourceFile {
  readonly canonicalRoot: string;
  readonly canonicalPath: string;
  /** Project-relative and `/`-separated, after links resolve. */
  readonly sourcePath: string;
}

/**
 * The one source lookup for document builds: a project-relative or in-project absolute path to an
 * existing file with one of `extensions`, still inside the project once links resolve.
 */
export const resolveProjectSourceFile = Effect.fn("ProjectDocumentBuild.resolveSourceFile")(
  function* (
    root: string,
    requestedPath: string,
    source: { readonly label: string; readonly extensions: ReadonlyArray<string> },
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceError = (code: ProjectDocumentSourceError["code"], message: string) =>
      new ProjectDocumentSourceError({ code, message });
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() =>
          sourceError("project-changed", "The current project workspace is unavailable."),
        ),
      );
    const relativePath = yield* projectRelativePath([root, canonicalRoot], requestedPath);
    if (relativePath === undefined) {
      return yield* sourceError(
        "invalid-source-path",
        `sourcePath ${requestedPath} is not inside this project (${canonicalRoot}). Pass a path inside it, relative to it or absolute.`,
      );
    }
    if (
      relativePath.split(/[\\/]/u).some((segment) => segment === "..") ||
      !source.extensions.includes(path.extname(relativePath).toLowerCase())
    ) {
      return yield* sourceError(
        "invalid-source-path",
        `sourcePath must identify a project ${source.extensions.join(", ")} file.`,
      );
    }
    const canonicalPath = yield* fileSystem
      .realPath(path.resolve(canonicalRoot, relativePath))
      .pipe(
        Effect.mapError(() =>
          sourceError(
            "source-not-found",
            `No file at ${requestedPath} in this project (${canonicalRoot}). Save the ${source.label} source there first, or pass its path relative to that folder.`,
          ),
        ),
      );
    if (!isInsideRoot(canonicalRoot, canonicalPath, path) || canonicalPath === canonicalRoot) {
      return yield* sourceError(
        "invalid-source-path",
        `The ${source.label} source must remain inside the current project workspace.`,
      );
    }
    const info = yield* fileSystem
      .stat(canonicalPath)
      .pipe(
        Effect.mapError(() =>
          sourceError(
            "source-not-found",
            `The ${source.label} source file could not be inspected.`,
          ),
        ),
      );
    if (info.type !== "File") {
      return yield* sourceError(
        "source-not-found",
        `The ${source.label} source path does not identify a file.`,
      );
    }
    return {
      canonicalRoot,
      canonicalPath,
      sourcePath: path.relative(canonicalRoot, canonicalPath).split(path.sep).join("/"),
    } satisfies ResolvedProjectSourceFile;
  },
);

export const resolveDocumentBuildProject = Effect.fn("ProjectDocumentBuild.resolveProject")(
  function* () {
    const invocation = yield* AgentInvocationContext.AgentInvocationContext;
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
  function* (root: string, outputPathInput: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() =>
          boundaryError("project-changed", "The current project workspace is unavailable."),
        ),
      );
    const requestedPath = yield* projectRelativePath([root, canonicalRoot], outputPathInput);
    if (requestedPath === undefined) {
      return yield* boundaryError(
        "invalid-output-path",
        `outputPath ${outputPathInput} is not inside this project (${canonicalRoot}). Pass a path inside it, relative to it or absolute.`,
      );
    }
    const segments = requestedPath.split(/[\\/]/u);
    if (
      segments.some((segment) => segment === "..") ||
      path.extname(requestedPath).toLowerCase() !== ".pdf"
    ) {
      return yield* boundaryError(
        "invalid-output-path",
        "outputPath must identify a project .pdf file.",
      );
    }

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

    const observed = yield* Effect.tryPromise({
      try: () => inspectGuardedFile(absolutePath),
      catch: () =>
        boundaryError("invalid-output-path", "Scient could not inspect the current PDF output."),
    });
    return {
      absolutePath,
      canonicalRoot,
      expectedRevision: observed?.revision ?? null,
      outputPath: path.relative(canonicalRoot, absolutePath).split(path.sep).join("/"),
    } satisfies ResolvedPdfOutput;
  },
);

export const prepareProjectPdfOutputIntent = (
  output: ResolvedPdfOutput,
  bytes: Uint8Array,
  intent: { readonly mutationId: string; readonly expectedMutationEpoch: string },
): ProjectPdfOutputIntent => Object.freeze({ output, bytes, ...intent });

export const publishProjectPdfOutput = Effect.fn("ProjectDocumentBuild.publishPdfOutput")(
  function* (intent: ProjectPdfOutputIntent) {
    const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return yield* workspace
      .writeBinaryFile({
        cwd: intent.output.canonicalRoot,
        relativePath: intent.output.outputPath,
        bytes: intent.bytes,
        mutationId: intent.mutationId,
        expectedMutationEpoch: intent.expectedMutationEpoch,
        ...(intent.output.expectedRevision === null
          ? { createOnly: true as const }
          : { expectedRevision: intent.output.expectedRevision }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectDocumentBuildBoundaryError({
              code: "output-write-failed",
              message: cause.message,
              mutationId: intent.mutationId,
              ...("publicationOutcome" in cause && cause.publicationOutcome !== undefined
                ? { publicationOutcome: cause.publicationOutcome }
                : {}),
              ...("recoveryId" in cause ? { recoveryId: cause.recoveryId } : {}),
              ...("retainedPaths" in cause ? { retainedPaths: cause.retainedPaths } : {}),
            }),
        ),
      );
  },
);
