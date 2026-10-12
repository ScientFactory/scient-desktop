import * as Base64Url from "effect/encoding/Base64Url";
// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures exercise the real project filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BindingGeneration, type PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ScientDocumentPageExpectation,
  ScientDocumentPageReadiness,
  ScientDocumentPageRenderResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
  type GeneratedDocumentStoreError,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";

const publicationHelper = await filePublicationTestHelper();

/** Shared fixtures for document export tests; never imported by production code. */

export const documentExportTestLayer = (prefix: string) => {
  const configLayer = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix });
      return ServerConfig.layerTest(
        process.cwd(),
        yield* fs.realPath(directory),
        publicationHelper === undefined ? {} : { filePublicationHelperPath: publicationHelper },
      );
    }),
  );
  return Layer.mergeAll(
    configLayer,
    WorkspacePaths.layer,
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
      Layer.provide(configLayer),
    ),
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
    ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

export async function makeFixtureDirectory(fixtures: string[], prefix: string): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  fixtures.push(root);
  return root;
}

export async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const filePath = NodePath.join(root, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, contents);
  return filePath;
}

/** A one-page PDF that PDF.js accepts. */
export function minimalPdf(marker: string): Uint8Array {
  const stream = `% ${marker}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

export const publishedSource = {
  _tag: "generated-pdf",
  authority: "environment-document-pdf-test",
  logicalDocumentKey: "markdown-pdf:fixture",
  title: "Report",
  fileName: "Report.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-1",
  revisionId: "revision-1",
  bindingGeneration: 1,
  bindingStatus: "current",
  staleReason: null,
  pageCount: 3,
} as PdfSourceDescriptor;

function readyReadiness(
  expected: ScientDocumentPageExpectation,
  overrides: Partial<ScientDocumentPageReadiness> = {},
): ScientDocumentPageReadiness {
  return {
    protocol: 1,
    status: "ready",
    captureId: expected.captureId,
    documentKind: expected.documentKind,
    sourceDigest: expected.sourceDigest,
    title: "Report",
    blocks: {
      headings: 2,
      paragraphs: 3,
      lists: 0,
      tables: 0,
      codeBlocks: 0,
      inlineMath: 0,
      displayMath: 0,
      diagrams: 0,
      images: 1,
    },
    unresolvedAssets: [],
    settled: { fonts: true, math: true, diagrams: true, images: true },
    diagnostics: [],
    ...overrides,
  };
}

export function renderResultFor(
  expected: ScientDocumentPageExpectation,
  overrides: Partial<ScientDocumentPageReadiness> = {},
  bytes: Uint8Array = minimalPdf("document-page"),
): ScientDocumentPageRenderResult {
  return {
    readiness: readyReadiness(expected, overrides),
    warnings: [],
    sourceSignals: {
      bodyTextLength: 120,
      imageCount: 1,
      brokenImageCount: 0,
      canvasCount: 0,
      videoCount: 0,
      iframeCount: 0,
      scrollWidth: 800,
      scrollHeight: 2_400,
    },
    blockedRequestCount: 0,
    bytesBase64: Base64Url.encode(bytes),
  };
}

export function makeGeneratedDocumentStore(options?: {
  readonly publishError?: GeneratedDocumentStoreError;
}) {
  const handle = {
    logicalDocumentKey: "markdown-pdf:fixture",
    operationId: "document-pdf-operation",
    producerId: "scient.document-pdf",
    generation: BindingGeneration.make(1),
  } as GeneratedDocumentProductionHandle;
  const beginProduction = vi.fn((_input: unknown) => Effect.succeed(handle));
  const publishPdf = vi.fn((_input: unknown) =>
    options?.publishError === undefined
      ? Effect.succeed(publishedSource)
      : Effect.fail(options.publishError),
  );
  const abandonProduction = vi.fn(() => Effect.succeed({} as never));
  const failProduction = vi.fn(() => Effect.succeed({} as never));
  const store = GeneratedDocumentStore.of({
    beginProduction,
    publishPdf,
    abandonProduction,
    failProduction,
  } as unknown as GeneratedDocumentStore["Service"]);
  return { store, beginProduction, publishPdf, abandonProduction, failProduction };
}
