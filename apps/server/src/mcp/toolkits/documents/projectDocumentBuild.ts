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
      "capability-unavailable",
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
