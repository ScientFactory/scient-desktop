// @effect-diagnostics nodeBuiltinImport:off -- Filesystem authority and content hashing stay server-owned.
import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  ControlledHtmlPdfRenderResult,
  EnvironmentFilePath,
  type ScientPdfBuildInput,
  type ScientPdfBuildResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { issueAssetUrl } from "../../../assets/AssetAccess.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ScientDocumentsToolkit, ScientPdfBuildToolError } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientPdfBuildToolError>[0]["code"];

interface PartialPublicationReceipt {
  readonly publishedSource: ScientPdfBuildResult["source"];
  readonly outputPath: ScientPdfBuildResult["outputPath"];
}

const toolError = (
  code: ErrorCode,
  message: string,
  receipt?: Partial<PartialPublicationReceipt>,
) => new ScientPdfBuildToolError({ code, message, ...receipt });

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);
const PRODUCER_ID = ArtifactProducerId.make("scient.html-pdf");
const decodeHostResult = Schema.decodeUnknownEffect(ControlledHtmlPdfRenderResult);

interface ResolvedHtmlSource {
  readonly canonicalPath: string;
  readonly sourcePath: string;
  readonly sha256: string;
}

interface ResolvedPdfOutput {
  readonly absolutePath: string;
  readonly canonicalRoot: string;
  readonly outputPath: string;
}

interface StagedPdfOutput {
  readonly finalPath: string;
  readonly temporaryPath: string;
}

const sourceHash = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const sourceLogicalDocumentKey = (canonicalPath: string): LogicalDocumentKey =>
  LogicalDocumentKey.make(
    `html-pdf:${NodeCrypto.createHash("sha256").update(canonicalPath).digest("hex")}`,
  );

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

const resolveHtmlSource = Effect.fn("ScientPdfBuild.resolveHtmlSource")(function* (
  root: string,
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (path.isAbsolute(requestedPath) || isWindowsAbsolutePath(requestedPath)) {
    return yield* toolError(
      "invalid-source-path",
      "sourcePath must be relative to the current Scient project.",
    );
  }
  const segments = requestedPath.split(/[\\/]/u);
  if (
    segments.some((segment) => segment === "..") ||
    !HTML_EXTENSIONS.has(path.extname(requestedPath).toLowerCase())
  ) {
    return yield* toolError(
      "invalid-source-path",
      "sourcePath must identify a project-relative .html, .htm, or .xhtml file.",
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
        toolError("source-not-found", "The HTML source file was not found in this project."),
      ),
    );
  const relativePath = path.relative(canonicalRoot, canonicalPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return yield* toolError(
      "invalid-source-path",
      "The HTML source must remain inside the current project workspace.",
    );
  }
  const info = yield* fileSystem
    .stat(canonicalPath)
    .pipe(
      Effect.mapError(() =>
        toolError("source-not-found", "The HTML source file could not be inspected."),
      ),
    );
  if (info.type !== "File") {
    return yield* toolError("source-not-found", "The HTML source path does not identify a file.");
  }
  const bytes = yield* fileSystem
    .readFile(canonicalPath)
    .pipe(
      Effect.mapError(() =>
        toolError("source-not-found", "The HTML source file could not be read."),
      ),
    );
  return {
    canonicalPath,
    sourcePath: relativePath.split(path.sep).join("/"),
    sha256: sourceHash(bytes),
  } satisfies ResolvedHtmlSource;
});

const resolvePdfOutput = Effect.fn("ScientPdfBuild.resolvePdfOutput")(function* (
  root: string,
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (path.isAbsolute(requestedPath) || isWindowsAbsolutePath(requestedPath)) {
    return yield* toolError(
      "invalid-output-path",
      "outputPath must be relative to the current Scient project.",
    );
  }
  const segments = requestedPath.split(/[\\/]/u);
  if (
    segments.some((segment) => segment === "..") ||
    path.extname(requestedPath).toLowerCase() !== ".pdf"
  ) {
    return yield* toolError(
      "invalid-output-path",
      "outputPath must identify a project-relative .pdf file.",
    );
  }

  const canonicalRoot = yield* fileSystem
    .realPath(root)
    .pipe(
      Effect.mapError(() =>
        toolError("project-changed", "The current project workspace is unavailable."),
      ),
    );
  const absolutePath = path.resolve(canonicalRoot, requestedPath);
  if (!isInsideRoot(canonicalRoot, absolutePath, path) || absolutePath === canonicalRoot) {
    return yield* toolError(
      "invalid-output-path",
      "The PDF output must remain inside the current project workspace.",
    );
  }

  const existingOutput = yield* fileSystem.stat(absolutePath).pipe(Effect.option);
  if (Option.isSome(existingOutput) && existingOutput.value.type !== "File") {
    return yield* toolError(
      "invalid-output-path",
      "The PDF output path must identify a file, not an existing directory or special entry.",
    );
  }

  let existingAncestor = path.dirname(absolutePath);
  while (true) {
    const canonicalAncestor = yield* fileSystem.realPath(existingAncestor).pipe(Effect.option);
    if (Option.isSome(canonicalAncestor)) {
      if (!isInsideRoot(canonicalRoot, canonicalAncestor.value, path)) {
        return yield* toolError(
          "invalid-output-path",
          "The PDF output must remain inside the current project workspace.",
        );
      }
      break;
    }
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return yield* toolError(
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
});

const stagePdfOutput = Effect.fn("ScientPdfBuild.stagePdfOutput")(function* (
  output: ResolvedPdfOutput,
  bytes: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetDirectory = path.dirname(output.absolutePath);
  const writeError = () =>
    toolError(
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
    return yield* toolError(
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

const commitStagedPdfOutput = Effect.fn("ScientPdfBuild.commitStagedPdfOutput")(function* (
  staged: StagedPdfOutput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .rename(staged.temporaryPath, staged.finalPath)
    .pipe(
      Effect.mapError(() =>
        toolError(
          "output-write-failed",
          "Scient validated the PDF but could not write it to the requested project path.",
        ),
      ),
    );
});

const resolveProject = Effect.fn("ScientPdfBuild.resolveProject")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("documents:build")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant document build access.",
    );
  }
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const thread = yield* snapshots
    .getThreadShellById(invocation.threadId)
    .pipe(
      Effect.mapError(() =>
        toolError("project-changed", "The current thread could not be resolved."),
      ),
    );
  if (Option.isNone(thread) || thread.value.projectId === null) {
    return yield* toolError(
      "project-required",
      "PDF builds require a thread that belongs to a Scient project.",
    );
  }
  const project = yield* snapshots
    .getProjectShellById(thread.value.projectId)
    .pipe(
      Effect.mapError(() =>
        toolError("project-changed", "The current project could not be resolved."),
      ),
    );
  if (Option.isNone(project)) {
    return yield* toolError("project-changed", "The project for this thread is no longer active.");
  }
  return {
    invocation,
    root: thread.value.worktreePath ?? project.value.workspaceRoot,
  };
});

const abandonQuietly = (
  store: GeneratedDocumentStore.GeneratedDocumentStore["Service"],
  handle: GeneratedDocumentStore.GeneratedDocumentProductionHandle,
  reason: string,
) => store.abandonProduction({ ...handle, reason }).pipe(Effect.ignore);

const failQuietly = (
  store: GeneratedDocumentStore.GeneratedDocumentStore["Service"],
  handle: GeneratedDocumentStore.GeneratedDocumentProductionHandle,
  reason: string,
) => store.failProduction({ ...handle, reason }).pipe(Effect.ignore);

export const buildScientPdfForInvocation = Effect.fn("ScientPdfBuild.build")(function* (
  input: ScientPdfBuildInput,
) {
  const { invocation, root } = yield* resolveProject();
  const initial = yield* resolveHtmlSource(root, input.sourcePath);
  const output = yield* resolvePdfOutput(root, input.outputPath);
  const generatedDocuments = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const handle = yield* generatedDocuments
    .beginProduction({
      logicalDocumentKey: sourceLogicalDocumentKey(initial.canonicalPath),
      operationId: ProducingOperationId.make(`html-pdf-${NodeCrypto.randomUUID()}`),
      producerId: PRODUCER_ID,
    })
    .pipe(
      Effect.mapError(() =>
        toolError("publication-failed", "Scient could not start the PDF build."),
      ),
    );

  const issued = yield* issueAssetUrl({
    resource: {
      _tag: "environment-file",
      path: EnvironmentFilePath.make(initial.canonicalPath),
      access: "html-document",
    },
    expiresInMs: 2 * 60_000,
  }).pipe(
    Effect.tapError(() =>
      abandonQuietly(generatedDocuments, handle, "HTML source authorization failed."),
    ),
    Effect.mapError(() =>
      toolError("source-not-found", "Scient could not authorize the HTML source."),
    ),
  );

  const rawRendered = yield* broker
    .invoke({
      scope: invocation,
      operation: "documentPdfRender",
      input: { assetRelativeUrl: issued.relativeUrl },
      timeoutMs: 75_000,
    })
    .pipe(
      Effect.tapError((cause) =>
        abandonQuietly(
          generatedDocuments,
          handle,
          "The controlled renderer did not complete.",
        ).pipe(
          Effect.andThen(
            Effect.logWarning("controlled HTML PDF render failed", { errorTag: cause._tag }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        toolError(
          cause._tag === "PreviewAutomationNoAvailableHostError" ||
            cause._tag === "PreviewAutomationUnsupportedClientError"
            ? "renderer-unavailable"
            : "render-failed",
          cause._tag === "PreviewAutomationNoAvailableHostError" ||
            cause._tag === "PreviewAutomationUnsupportedClientError"
            ? "A current connected Scient desktop is required to build this PDF."
            : "Scient could not render the HTML document as PDF.",
        ),
      ),
    );
  const rendered = yield* decodeHostResult(rawRendered).pipe(
    Effect.tapError(() =>
      abandonQuietly(generatedDocuments, handle, "The renderer response was invalid."),
    ),
    Effect.mapError(() =>
      toolError("render-failed", "The desktop returned an invalid PDF render result."),
    ),
  );

  const latest = yield* resolveHtmlSource(root, input.sourcePath).pipe(
    Effect.catch(() =>
      abandonQuietly(generatedDocuments, handle, "The HTML source changed during rendering.").pipe(
        Effect.andThen(
          Effect.fail(
            toolError("source-changed", "The HTML source changed while the PDF was being built."),
          ),
        ),
      ),
    ),
  );
  if (latest.canonicalPath !== initial.canonicalPath || latest.sha256 !== initial.sha256) {
    yield* abandonQuietly(generatedDocuments, handle, "The HTML source changed during rendering.");
    return yield* toolError(
      "source-changed",
      "The HTML source changed while the PDF was being built. Run the build again.",
    );
  }

  const bytes = yield* Effect.try({
    try: () => Result.getOrThrow(Encoding.decodeBase64Url(rendered.bytesBase64)),
    catch: () => toolError("render-failed", "The desktop returned invalid PDF bytes."),
  }).pipe(
    Effect.tapError(() =>
      abandonQuietly(generatedDocuments, handle, "The renderer bytes were invalid."),
    ),
  );
  if (bytes.byteLength > BROWSER_PDF_EXPORT_MAX_BYTES) {
    yield* abandonQuietly(generatedDocuments, handle, "The rendered PDF exceeded the size limit.");
    return yield* toolError("render-failed", "The generated PDF exceeds the current 64 MiB limit.");
  }

  const fallbackTitle = initial.sourcePath
    .slice(initial.sourcePath.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/u, "")
    .slice(0, 512);
  const title = rendered.title.trim() || fallbackTitle || "Document";
  const { source, projectOutputWritten } = yield* Effect.scoped(
    Effect.gen(function* () {
      const staged = yield* stagePdfOutput(output, bytes).pipe(
        Effect.tapError(() =>
          abandonQuietly(
            generatedDocuments,
            handle,
            "The requested project output could not be staged.",
          ),
        ),
      );
      const source = yield* generatedDocuments
        .publishPdf({
          ...handle,
          bytes,
          title,
          provenanceKind: "controlled-render",
          validationProfile: "browser-export",
        })
        .pipe(
          Effect.tapError((cause) => failQuietly(generatedDocuments, handle, cause.detail)),
          Effect.mapError(() =>
            toolError(
              "publication-failed",
              "Scient rejected or could not store the generated PDF.",
            ),
          ),
        );
      if (source._tag !== "generated-pdf") {
        return yield* toolError("publication-failed", "Scient returned an unsupported PDF source.");
      }

      const projectOutputWritten = yield* commitStagedPdfOutput(staged).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("published HTML PDF could not replace its project output", {
            errorCode: cause.code,
            outputPath: output.outputPath,
          }).pipe(Effect.as(false)),
        ),
      );
      return { source, projectOutputWritten };
    }),
  );

  const presented = yield* broker
    .invoke({
      scope: invocation,
      operation: "documentPdfPresent",
      input: { source },
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("generated HTML PDF could not be presented", {
          errorTag: cause._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  if (!projectOutputWritten) {
    return yield* toolError(
      "partial-publication",
      "Scient stored an immutable PDF revision, but could not write the requested project file. The publishedSource receipt identifies the available revision; outputPath was not written.",
      { publishedSource: source, outputPath: output.outputPath },
    );
  }

  const warnings = [
    ...new Set([
      ...rendered.warnings,
      ...(rendered.blockedRequestCount > 0 ? ["blocked-external-resources"] : []),
      ...(presented ? [] : ["presentation-unavailable"]),
    ]),
  ].slice(0, 32);
  return {
    sourcePath: initial.sourcePath,
    outputPath: output.outputPath,
    source,
    title,
    pageCount: source.pageCount ?? 1,
    byteLength: bytes.byteLength,
    warnings,
    validation: "structural",
    visualReviewPerformed: false,
  } satisfies ScientPdfBuildResult;
});

const handlers = {
  scient_pdf_build: buildScientPdfForInvocation,
} satisfies Parameters<typeof ScientDocumentsToolkit.toLayer>[0];

export const ScientDocumentsToolkitHandlersLive = ScientDocumentsToolkit.toLayer(handlers);
