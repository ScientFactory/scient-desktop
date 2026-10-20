import * as Base64Url from "effect/encoding/Base64Url";
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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { issueAssetUrl } from "../../../assets/AssetAccess.ts";
import { observeAnalyticsEffect } from "../../../telemetry/OperationAnalytics.ts";
import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as DocumentHostBroker from "../../../scient/documents/DocumentHostBroker.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import type { WorkspacePathsError } from "../../../workspace/WorkspacePaths.ts";
import type { WorkspaceMutationError } from "../../../scient/workspace/WorkspaceFileMutations.ts";
import { exportScientDocumentForInvocation } from "./documentExportHandler.ts";
import { buildScientLatexForInvocation } from "./latexHandler.ts";
import {
  assertCurrentDocumentBuildProject,
  publishProjectPdfOutput,
  isWindowsAbsolutePath,
  type ProjectDocumentBuildBoundaryError,
  resolveDocumentBuildProject,
  resolveProjectPdfOutput,
  prepareProjectPdfOutputIntent,
} from "./projectDocumentBuild.ts";
import { ScientDocumentsToolkit, ScientPdfBuildToolError } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientPdfBuildToolError>[0]["code"];

interface PartialPublicationReceipt {
  readonly publishedSource: ScientPdfBuildResult["source"];
  readonly outputPath: ScientPdfBuildResult["outputPath"];
  readonly publicationOutcome: ProjectDocumentBuildBoundaryError["publicationOutcome"];
  readonly recoveryId: ProjectDocumentBuildBoundaryError["recoveryId"];
  readonly retainedPaths: ProjectDocumentBuildBoundaryError["retainedPaths"];
  readonly mutationId: ProjectDocumentBuildBoundaryError["mutationId"];
}

const toolError = (
  code: ErrorCode,
  message: string,
  receipt?: Partial<PartialPublicationReceipt>,
) =>
  new ScientPdfBuildToolError({
    code,
    message,
    ...(receipt?.publishedSource === undefined ? {} : { publishedSource: receipt.publishedSource }),
    ...(receipt?.outputPath === undefined ? {} : { outputPath: receipt.outputPath }),
    ...(receipt?.publicationOutcome === undefined
      ? {}
      : { publicationOutcome: receipt.publicationOutcome }),
    ...(receipt?.recoveryId === undefined ? {} : { recoveryId: receipt.recoveryId }),
    ...(receipt?.retainedPaths === undefined ? {} : { retainedPaths: receipt.retainedPaths }),
    ...(receipt?.mutationId === undefined ? {} : { mutationId: receipt.mutationId }),
  });

const workspacePublicationReceipt = (
  cause: WorkspaceMutationError | WorkspacePathsError,
): Partial<PartialPublicationReceipt> => ({
  ...("publicationOutcome" in cause ? { publicationOutcome: cause.publicationOutcome } : {}),
  ...("recoveryId" in cause ? { recoveryId: cause.recoveryId } : {}),
  ...("retainedPaths" in cause ? { retainedPaths: cause.retainedPaths } : {}),
  ...("mutationId" in cause ? { mutationId: cause.mutationId } : {}),
});

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);
const PRODUCER_ID = ArtifactProducerId.make("scient.html-pdf");
const decodeHostResult = Schema.decodeUnknownEffect(ControlledHtmlPdfRenderResult);

interface ResolvedHtmlSource {
  readonly canonicalPath: string;
  readonly sourcePath: string;
  readonly sha256: string;
}

const sourceHash = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const sourceLogicalDocumentKey = (canonicalPath: string): LogicalDocumentKey =>
  LogicalDocumentKey.make(
    `html-pdf:${NodeCrypto.createHash("sha256").update(canonicalPath).digest("hex")}`,
  );

const boundaryToolError = (cause: ProjectDocumentBuildBoundaryError) =>
  toolError(cause.code, cause.message, cause);

const resolveHtmlSourceFile = Effect.fn("ScientPdfBuild.resolveHtmlSourceFile")(function* (
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
  return { canonicalPath, sourcePath: relativePath.split(path.sep).join("/") };
});

const resolveHtmlSource = Effect.fn("ScientPdfBuild.resolveHtmlSource")(function* (
  root: string,
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* resolveHtmlSourceFile(root, requestedPath);
  const bytes = yield* fileSystem
    .readFile(source.canonicalPath)
    .pipe(
      Effect.mapError(() =>
        toolError("source-not-found", "The HTML source file could not be read."),
      ),
    );
  return { ...source, sha256: sourceHash(bytes) } satisfies ResolvedHtmlSource;
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
  const authority = yield* resolveDocumentBuildProject().pipe(Effect.mapError(boundaryToolError));
  const { invocation, root } = authority;
  const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  // Path errors precede the publication fence; bytes are still captured only
  // under the settled read and checked against the original epoch afterwards.
  yield* resolveHtmlSourceFile(root, input.sourcePath);
  const mutationEpoch = yield* workspace
    .getMutationEpoch({ cwd: root })
    .pipe(
      Effect.mapError((cause) =>
        toolError("source-changed", cause.message, workspacePublicationReceipt(cause)),
      ),
    );
  const initial = yield* workspace
    .withSettledWorkspaceRead({ cwd: root, relativePath: input.sourcePath }, (attention) =>
      attention === null
        ? resolveHtmlSource(root, input.sourcePath)
        : Effect.fail(
            toolError("source-changed", attention.message, {
              ...attention,
              publicationOutcome: "retained-attention",
            }),
          ),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ScientPdfBuildToolError"
          ? cause
          : toolError("source-changed", cause.message, workspacePublicationReceipt(cause)),
      ),
    );
  const capturedEpoch = yield* workspace
    .getMutationEpoch({ cwd: root })
    .pipe(
      Effect.mapError((cause) =>
        toolError("source-changed", cause.message, workspacePublicationReceipt(cause)),
      ),
    );
  if (capturedEpoch !== mutationEpoch) {
    return yield* toolError(
      "source-changed",
      "The workspace changed while the HTML source was captured. Run the build again.",
    );
  }
  const output = yield* resolveProjectPdfOutput(root, input.outputPath).pipe(
    Effect.mapError(boundaryToolError),
  );
  const generatedDocuments = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const broker = yield* DocumentHostBroker.DocumentHostBroker;
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
    try: () => Result.getOrThrow(Base64Url.decode(rendered.bytesBase64)),
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
  const intent = prepareProjectPdfOutputIntent(output, bytes, {
    mutationId: `html-pdf-output:${handle.operationId}:${output.outputPath}`,
    expectedMutationEpoch: mutationEpoch,
  });
  const source = yield* workspace
    .withWorkspacePublicationFence({ cwd: root, expectedEpoch: mutationEpoch }, () =>
      Effect.gen(function* () {
        yield* assertCurrentDocumentBuildProject(authority).pipe(
          Effect.mapError(boundaryToolError),
        );
        const current = yield* resolveHtmlSource(root, input.sourcePath);
        if (current.canonicalPath !== initial.canonicalPath || current.sha256 !== initial.sha256) {
          return yield* toolError(
            "source-changed",
            "The HTML source changed before PDF publication. Run the build again.",
          );
        }
        return yield* generatedDocuments
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
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ScientPdfBuildToolError"
          ? cause
          : toolError("source-changed", cause.message, workspacePublicationReceipt(cause)),
      ),
      Effect.tapError(() =>
        abandonQuietly(generatedDocuments, handle, "PDF publication admission failed."),
      ),
    );
  if (source._tag !== "generated-pdf") {
    return yield* toolError("publication-failed", "Scient returned an unsupported PDF source.");
  }
  const outputError = yield* assertCurrentDocumentBuildProject(authority).pipe(
    Effect.andThen(publishProjectPdfOutput(intent)),
    Effect.as(null),
    Effect.catch((cause) => Effect.succeed(cause)),
  );

  const authorityStillCurrent = yield* assertCurrentDocumentBuildProject(authority).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!authorityStillCurrent || outputError?.code === "project-changed") {
    return yield* toolError(
      outputError === null ? "project-changed" : "partial-publication",
      outputError === null
        ? "Scient wrote the PDF to the workspace where the build began, but the active workspace changed before presentation. The PDF was not opened in the new workspace."
        : "Scient stored an immutable PDF revision, but could not accept the requested project output. The publishedSource receipt identifies the available revision. Inspect the publication outcome before retrying.",
      { ...outputError, publishedSource: source, outputPath: output.outputPath },
    );
  }

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

  if (outputError !== null) {
    return yield* toolError(
      "partial-publication",
      outputError.publicationOutcome === "unchanged"
        ? "Scient stored an immutable PDF revision, but the native publication authority refused the project output unchanged. The publishedSource receipt identifies the available revision."
        : "Scient stored an immutable PDF revision, but project output acceptance failed. The workspace mutation may have applied; inspect the publication outcome and recovery receipt before retrying.",
      { ...outputError, publishedSource: source, outputPath: output.outputPath },
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
  scient_pdf_build: (input) =>
    observeAnalyticsEffect(buildScientPdfForInvocation(input), {
      kind: "pdf-export",
      trigger: "agent",
    }),
  scient_latex_build: (input) => buildScientLatexForInvocation(input),
  scient_document_export: (input) =>
    observeAnalyticsEffect(exportScientDocumentForInvocation(input), {
      kind: "pdf-export",
      trigger: "agent",
    }),
} satisfies Parameters<typeof ScientDocumentsToolkit.toLayer>[0];

export const ScientDocumentsToolkitHandlersLive = ScientDocumentsToolkit.toLayer(handlers);
