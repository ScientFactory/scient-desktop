// @effect-diagnostics nodeBuiltinImport:off -- The test writes a synthetic project and PDF to a temporary folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { attachScientSourcePdf, importScientSource } from "@scientfactory/scient-sources/store";
import type { ScientAnnotationCommand } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { readerAnchor, textPdf } from "../annotations/annotationTestUtils.ts";
import { layer as annotationsLayer, ScientAnnotations } from "../annotations/ScientAnnotations.ts";
import { sourceAttachmentPreview } from "./SourceAttachmentPreview.ts";
import { resolveScientSourcesStoreFor, ScientSourcesBackend } from "./SourcesBackend.ts";

const PAGE = "We studied sleep in mice.";

const candidate: ScientSourceCandidate = {
  sourceKey: "sleep-paper",
  type: "article",
  customType: null,
  title: "Sleep and memory",
  creators: [],
  issuedRaw: null,
  issuedYear: 2024,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
};

const config = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-source-preview-",
});
// A Source preview issues a workspace file: no favicon or tool-output lookup.
const testLayer = Layer.mergeAll(
  annotationsLayer,
  config,
  WorkspacePaths.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(config)))),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)));

const project = Effect.acquireRelease(
  Effect.promise(async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-preview-")),
    );
    const root = NodePath.join(base, "project");
    await NodeFSP.mkdir(root);
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const pdfPath = NodePath.join(base, "sleep.pdf");
    await NodeFSP.writeFile(pdfPath, textPdf([["Sleep and memory", PAGE]]));
    const attached = await attachScientSourcePdf({
      root,
      sourceId: imported.record!.sourceId,
      expectedRevision: imported.record!.revision,
      pdfPath,
    });
    const attachment = attached.record.attachments[0]!;
    const { projectId } = await readScientProjectIdentity(root);
    return {
      base,
      root,
      projectId,
      sourceId: imported.record!.sourceId,
      attachmentId: attachment.attachmentId,
      v1Path: `.scient/sources/${attachment.relativePath}`,
      material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
    };
  }),
  ({ base }) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
);

const create = (annotationId: string, quote: string): ScientAnnotationCommand => ({
  action: "create",
  annotationId,
  anchor: readerAnchor({ text: PAGE, quote }),
  highlighted: true,
  note: "",
});

const ids = (annotations: ReadonlyArray<{ readonly annotationId: string }>) =>
  annotations.map((annotation) => annotation.annotationId).toSorted();

describe("source attachment preview", () => {
  it.effect("names a moved PDF so the reader finds, adds and reopens its highlights", () =>
    Effect.gen(function* () {
      const fixture = yield* project;
      const { root, sourceId, attachmentId } = fixture;
      const annotations = yield* ScientAnnotations;
      yield* annotations
        .mutate(
          {
            root,
            relativePath: fixture.v1Path,
            material: fixture.material,
            command: create("ann_before01", "sleep"),
          },
          "user",
        )
        .pipe(Effect.provideService(ScientSourcesBackend, "project"));

      const library = yield* resolveScientSourcesStoreFor(
        { projectId: fixture.projectId, root },
        "write",
      );
      if (library.kind !== "library") throw new Error("Expected the project to move");

      // The reader is handed this answer, unchanged.
      const answer = yield* sourceAttachmentPreview(library, { root, sourceId, attachmentId });
      expect(answer.material).toEqual(fixture.material);
      const opened = yield* annotations.forDocument({ root, relativePath: answer.sourcePath! });
      expect(opened.status === "available" && ids(opened.annotations)).toEqual(["ann_before01"]);

      yield* annotations.mutate(
        {
          root,
          relativePath: answer.sourcePath!,
          material: answer.material!,
          command: create("ann_after001", "mice"),
        },
        "user",
      );
      const reopened = yield* annotations.forDocument({
        root,
        relativePath: (yield* sourceAttachmentPreview(library, { root, sourceId, attachmentId }))
          .sourcePath!,
      });
      expect(reopened.status === "available" && ids(reopened.annotations)).toEqual([
        "ann_after001",
        "ann_before01",
      ]);
    }).pipe(Effect.provideService(ScientSourcesBackend, "library"), Effect.provide(testLayer)),
  );
});
