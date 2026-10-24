// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import {
  GeneratedDocumentStore,
  GeneratedDocumentStoreError,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import {
  documentExportTestLayer,
  makeFixtureDirectory,
  minimalPdf,
  writeFixtureFile,
} from "../documentExport/DocumentExportTestUtils.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";
import { revisionForBytes } from "../workspace/WorkspaceFileMutations.ts";
import { savePdfFileEdit } from "./PdfFileEdits.ts";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const BLOB = ".scient/sources/files/sha256/ab/abcdef.pdf";
const original = minimalPdf("original");
const edited = minimalPdf("edited");

function makeStore(copyPath: string) {
  const copy = {
    _tag: "generated-pdf",
    authority: "environment-pdf-edit-test",
    logicalDocumentKey: "pdf-edit:operation-1",
    title: "Paper (edited)",
    fileName: "Paper.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: "artifact-1",
    revisionId: "revision-1",
    bindingGeneration: 1,
    bindingStatus: "current",
    staleReason: null,
  } as PdfSourceDescriptor;
  const publishPdf = vi.fn((_input: { readonly bytes: Uint8Array; readonly title: string }) =>
    Effect.succeed(copy),
  );
  const store = GeneratedDocumentStore.of({
    getDescriptor: () =>
      Effect.fail(
        new GeneratedDocumentStoreError({
          operation: "read-binding",
          reason: "missing-binding",
          detail: "No binding.",
        }),
      ),
    beginProduction: () => Effect.succeed({ generation: 1 }),
    publishPdf,
    failProduction: () => Effect.void,
    resolveRevision: () => Effect.succeed({ path: copyPath }),
  } as unknown as GeneratedDocumentStore["Service"]);
  return { store, publishPdf };
}

const layer = Layer.orDie(documentExportTestLayer("scient-pdf-edit-test-")).pipe(
  Layer.provideMerge(layerKnownWorkspacesAllowAll),
);

function workspaceSource(root: string, relativePath: string, fromSources: boolean) {
  return {
    _tag: "workspace-pdf",
    authority: "environment-pdf-edit-test",
    logicalDocumentKey: `workspace:${relativePath}`,
    title: "Paper",
    fileName: "Paper.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: true },
    workspaceRoot: root,
    relativePath,
    ...(fromSources
      ? { origin: { _tag: "source", workspaceRoot: root, sourceId: "s1", attachmentId: "a1" } }
      : {}),
  } as PdfSourceDescriptor;
}

const save = (input: {
  readonly root: string;
  readonly source: PdfSourceDescriptor;
  readonly expectedRevision?: string;
}) =>
  Effect.gen(function* () {
    const upload = yield* Effect.promise(() => writeFixtureFile(input.root, "upload.tmp", edited));
    const { store, publishPdf } = makeStore(NodePath.join(input.root, "copy.pdf"));
    const result = yield* savePdfFileEdit({
      source: input.source,
      expectedRevision: input.expectedRevision ?? revisionForBytes(original),
      operationId: "operation-1",
      temporaryPath: upload,
    }).pipe(Effect.provideService(GeneratedDocumentStore, store), Effect.result);
    return { result, publishPdf };
  });

const readFixture = (root: string, relativePath: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, relativePath)));

describe("PdfFileEdits", () => {
  it.layer(layer)((it) => {
    it.effect("saves a Sources PDF as an edited copy and leaves the shared file unchanged", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "pdf-edit-"));
        yield* Effect.promise(() => writeFixtureFile(root, BLOB, original));
        const { result, publishPdf } = yield* save({
          root,
          source: workspaceSource(root, BLOB, true),
        });
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(result.success.createdCopy).toBe(true);
        expect(result.success.source._tag).toBe("generated-pdf");
        expect(publishPdf).toHaveBeenCalledOnce();
        expect(Buffer.from(publishPdf.mock.calls[0]![0].bytes)).toEqual(Buffer.from(edited));
        expect(publishPdf.mock.calls[0]![0].title).toBe("Paper (edited)");
        expect(yield* readFixture(root, BLOB)).toEqual(Buffer.from(original));
      }),
    );

    it.effect("never writes inside the Sources folder, even without a Sources origin", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "pdf-edit-"));
        yield* Effect.promise(() => writeFixtureFile(root, BLOB, original));
        const { result } = yield* save({ root, source: workspaceSource(root, BLOB, false) });
        expect(result._tag === "Success" && result.success.createdCopy).toBe(true);
        expect(yield* readFixture(root, BLOB)).toEqual(Buffer.from(original));
      }),
    );

    it.effect(
      "classifies a Sources file reached through a linked folder by its real location",
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "pdf-edit-"));
          yield* Effect.promise(() => writeFixtureFile(root, BLOB, original));
          yield* Effect.promise(() =>
            NodeFSP.symlink(
              NodePath.join(root, NodePath.dirname(BLOB)),
              NodePath.join(root, "alias"),
            ),
          );
          const rootedAtAlias = yield* save({
            root,
            source: workspaceSource(NodePath.join(root, "alias"), "abcdef.pdf", false),
          });
          expect(
            rootedAtAlias.result._tag === "Success" && rootedAtAlias.result.success.createdCopy,
          ).toBe(true);
          const environment = yield* save({
            root,
            source: {
              _tag: "environment-pdf",
              authority: "environment-pdf-edit-test",
              logicalDocumentKey: "environment:alias",
              title: "Paper",
              fileName: "Paper.pdf",
              capabilities: { canSaveCopy: true, canRevealSource: true },
              path: NodePath.join(root, "alias", "abcdef.pdf"),
            } as PdfSourceDescriptor,
          });
          expect(
            environment.result._tag === "Success" && environment.result.success.createdCopy,
          ).toBe(true);
          expect(yield* readFixture(root, BLOB)).toEqual(Buffer.from(original));
        }),
    );

    it.effect("refuses to copy a Sources PDF that differs from the edited revision", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "pdf-edit-"));
        yield* Effect.promise(() => writeFixtureFile(root, BLOB, original));
        const { result, publishPdf } = yield* save({
          root,
          source: workspaceSource(root, BLOB, true),
          expectedRevision: revisionForBytes(minimalPdf("someone else")),
        });
        expect(result._tag).toBe("Failure");
        expect(publishPdf).not.toHaveBeenCalled();
        expect(yield* readFixture(root, BLOB)).toEqual(Buffer.from(original));
      }),
    );

    it.effect("still saves an ordinary project PDF in place", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "pdf-edit-"));
        yield* Effect.promise(() => writeFixtureFile(root, "papers/paper.pdf", original));
        const { result, publishPdf } = yield* save({
          root,
          source: workspaceSource(root, "papers/paper.pdf", false),
        });
        expect(result._tag === "Success" && result.success.createdCopy).toBe(false);
        expect(publishPdf).not.toHaveBeenCalled();
        expect(yield* readFixture(root, "papers/paper.pdf")).toEqual(Buffer.from(edited));
      }),
    );
  });
});
