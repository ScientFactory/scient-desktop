// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import {
  documentExportTestLayer,
  makeFixtureDirectory,
  minimalPdf,
  writeFixtureFile,
} from "../documentExport/DocumentExportTestUtils.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";
import { revisionForBytes } from "../workspace/WorkspaceFileMutations.ts";
import { isInSourceFileStore, isInSourcesFolder } from "./sourceFileStore.ts";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const BLOB = ".scient/sources/files/sha256/ab/abcdef.pdf";
const layer = Layer.orDie(documentExportTestLayer("scient-source-store-test-")).pipe(
  Layer.provideMerge(layerKnownWorkspacesAllowAll),
);

describe("Sources file store", () => {
  it("recognizes Sources paths in any letter case", () => {
    expect(isInSourceFileStore(`/project/${BLOB}`)).toBe(true);
    expect(isInSourceFileStore("/project/.Scient/Sources/Files/SHA256/ab/x.pdf")).toBe(true);
    expect(isInSourceFileStore("/project/.scient/sources/records/x.json")).toBe(false);
    expect(isInSourcesFolder("/project/.scient/sources/records/x.json")).toBe(true);
    expect(isInSourcesFolder("/project/papers/sources/x.pdf")).toBe(false);
  });

  it.layer(layer)((it) => {
    it.effect("is never written by the shared file writer", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeFixtureDirectory(fixtures, "source-store-"));
        const original = minimalPdf("original");
        yield* Effect.promise(() => writeFixtureFile(root, BLOB, original));
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const result = yield* files
          .writeBinaryFile({
            cwd: root,
            relativePath: BLOB,
            mutationId: "source-store-write",
            expectedRevision: revisionForBytes(original),
            bytes: minimalPdf("edited"),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, BLOB)))).toEqual(
          Buffer.from(original),
        );
      }),
    );
  });
});
