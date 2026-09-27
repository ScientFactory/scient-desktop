// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  ScientDocumentPageInput,
  type ScientDocumentPdfPrepared,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { resolveAsset } from "../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { readDocumentCapture, sha256Digest } from "./DocumentCapture.ts";
import {
  documentExportTestLayer,
  makeFixtureDirectory,
  makeGeneratedDocumentStore,
  minimalPdf,
  publishedSource,
  renderResultFor,
  writeFixtureFile,
} from "./DocumentExportTestUtils.ts";
import {
  DOCUMENT_PDF_TOO_LARGE_DETAIL,
  publishCapturedDocumentPdf,
} from "./DocumentPdfPublication.ts";
import { prepareMarkdownPdf } from "./MarkdownPdfPreparation.ts";

const fixtures: string[] = [];
const layer = Layer.orDie(documentExportTestLayer("scient-document-pdf-test-"));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const decodePageInput = Schema.decodeUnknownSync(Schema.fromJsonString(ScientDocumentPageInput));

const REPORT = [
  "# Quarterly *report*",
  "",
  "![Plot](figures/plot.png) ![Remote](https://example.com/r.png)",
  "",
  "![Missing](figures/missing.png) ![Outside](../../outside.png)",
  "",
  "```md",
  "![Code](figures/plot.png)",
  "```",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const writeReport = async (contents = REPORT) => {
  const root = await makeFixtureDirectory(fixtures, "scient-document-pdf-project-");
  await writeFixtureFile(root, "notes/report.md", contents);
  await writeFixtureFile(root, "notes/figures/plot.png", PNG);
  return { root, revision: sha256Digest(new TextEncoder().encode(contents)) };
};

const readCapturedInput = (prepared: ScientDocumentPdfPrepared, file = "document.json") =>
  Effect.gen(function* () {
    const token = prepared.inputRelativeUrl.split("/")[3]!;
    const asset = yield* resolveAsset(token, file).pipe(
      Effect.provideService(
        NativeAppIconResolver.NativeAppIconResolver,
        NativeAppIconResolver.NativeAppIconResolver.of({
          resolve: () => Effect.succeed(null),
        } as unknown as NativeAppIconResolver.NativeAppIconResolver["Service"]),
      ),
    );
    if (asset === null || asset.kind !== "file") return null;
    return yield* Effect.promise(() => NodeFSP.readFile(asset.path));
  });

describe("Markdown PDF preparation", () => {
  it.effect("captures the saved revision as a bundle with copied images and warnings", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* Effect.promise(() => writeReport());
      const prepared = yield* prepareMarkdownPdf({
        cwd: root,
        relativePath: "notes/report.md",
        expectedRevision: revision,
      });

      expect(prepared.title).toBe("Quarterly report");
      expect(prepared.expected).toMatchObject({
        documentKind: "workspace-file",
        sourceDigest: revision,
      });
      expect(prepared.inputRelativeUrl).toMatch(/^\/api\/assets\/[^/]+\/document\.json$/u);
      expect(prepared.inputRelativeUrl).not.toContain(root);
      expect(prepared.warnings.map((warning) => warning.message)).toEqual([
        'Image "figures/missing.png" was not found in the project.',
        'Image "../../outside.png" is outside the project and was not included.',
      ]);

      const input = decodePageInput(
        new TextDecoder().decode((yield* readCapturedInput(prepared))!),
      );
      expect(input).toMatchObject({
        captureId: prepared.expected.captureId,
        documentKind: "workspace-file",
        sourceDigest: revision,
        profile: "document",
        direction: "auto",
      });
      expect(input.markdown).toBe(
        REPORT.replace("](figures/plot.png)", "](scient-asset:image-0001)")
          .replace("](figures/missing.png)", "](scient-asset:image-0002)")
          .replace("](../../outside.png)", "](scient-asset:image-0003)"),
      );
      expect(input.markdown).toContain("![Code](figures/plot.png)");
      expect(input.assets).toEqual([
        {
          id: "image-0001",
          role: "image",
          fileName: "plot.png",
          mediaType: "image/png",
          content: { _tag: "captured", path: "assets/0001.png" },
        },
        expect.objectContaining({
          id: "image-0002",
          content: { _tag: "unavailable", reason: "missing" },
        }),
        expect.objectContaining({
          id: "image-0003",
          content: { _tag: "unavailable", reason: "missing" },
        }),
      ]);
      expect(yield* readCapturedInput(prepared, "assets/0001.png")).toEqual(Buffer.from(PNG));
      // The server-only record never travels through the page's capability.
      expect(yield* readCapturedInput(prepared, ".capture.json")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a file that differs from the editor's saved revision", () =>
    Effect.gen(function* () {
      const { root } = yield* Effect.promise(() => writeReport());
      const error = yield* prepareMarkdownPdf({
        cwd: root,
        relativePath: "notes/report.md",
        expectedRevision: sha256Digest(new TextEncoder().encode("older")),
      }).pipe(Effect.flip);
      expect(error.reason).toBe("source-changed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects paths that are not project Markdown files", () =>
    Effect.gen(function* () {
      const { root, revision } = yield* Effect.promise(() => writeReport());
      const outside = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-outside-"),
      );
      yield* Effect.promise(() => writeFixtureFile(outside, "secret.md", "# Secret"));
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(outside, "secret.md"), NodePath.join(root, "linked.md")),
      );
      for (const [relativePath, reason] of [
        ["notes/figures/plot.png", "invalid-source"],
        ["../report.md", "invalid-source"],
        [NodePath.join(root, "notes/report.md"), "invalid-source"],
        ["linked.md", "invalid-source"],
        ["notes/absent.md", "source-unavailable"],
      ] as const) {
        const error = yield* prepareMarkdownPdf({
          cwd: root,
          relativePath,
          expectedRevision: revision,
        }).pipe(Effect.flip);
        expect(error.reason, relativePath).toBe(reason);
      }
    }).pipe(Effect.provide(layer)),
  );
});

describe("document PDF publication", () => {
  const prepare = Effect.gen(function* () {
    const { root, revision } = yield* Effect.promise(() => writeReport());
    const prepared = yield* prepareMarkdownPdf({
      cwd: root,
      relativePath: "notes/report.md",
      expectedRevision: revision,
    });
    return { root, prepared };
  });

  it.effect("publishes a matching render as a controlled revision and clears the capture", () =>
    Effect.gen(function* () {
      const { prepared } = yield* prepare;
      const store = makeGeneratedDocumentStore();
      const published = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: renderResultFor(prepared.expected, {
          diagnostics: [
            {
              severity: "warning",
              code: "remote-image-omitted",
              detail: 'Remote image "https://example.com/r.png" was not downloaded.',
            },
          ],
        }),
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store));

      expect(published).toMatchObject({
        source: publishedSource,
        title: "Quarterly report",
        pageCount: 3,
        byteLength: minimalPdf("document-page").byteLength,
      });
      expect(published.warnings.map((warning) => warning.code)).toEqual([
        "resource-unresolved",
        "resource-unresolved",
        "resource-unresolved",
      ]);
      expect(store.beginProduction).toHaveBeenCalledWith(
        expect.objectContaining({ producerId: "scient.document-pdf" }),
      );
      expect(store.publishPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Quarterly report",
          provenanceKind: "controlled-render",
          validationProfile: "browser-export",
        }),
      );
      const reread = yield* readDocumentCapture(prepared.expected.captureId).pipe(Effect.flip);
      expect(reread.reason).toBe("capture-expired");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a wrong, stale, or unfinished page before publication", () =>
    Effect.gen(function* () {
      const cases = [
        { captureId: "00000000-0000-4000-8000-000000000000" },
        { documentKind: "conversation" },
        { sourceDigest: sha256Digest(new Uint8Array([1])) },
        { status: "failed" },
        { settled: { fonts: true, math: true, diagrams: false, images: true } },
        { unresolvedAssets: ["image-0001"] },
        {
          diagnostics: [
            {
              severity: "fatal",
              code: "diagram-incomplete",
              detail: "A diagram did not finish rendering.",
            },
          ],
        },
      ] as const;
      for (const overrides of cases) {
        const { prepared } = yield* prepare;
        const store = makeGeneratedDocumentStore();
        const error = yield* publishCapturedDocumentPdf({
          captureId: prepared.expected.captureId,
          render: renderResultFor(prepared.expected, overrides as never),
        }).pipe(Effect.provideService(GeneratedDocumentStore, store.store), Effect.flip);
        expect(error.reason, Object.keys(overrides).join(",")).toBe("render-rejected");
        expect(store.publishPdf).not.toHaveBeenCalled();
        const reread = yield* readDocumentCapture(prepared.expected.captureId).pipe(Effect.flip);
        expect(reread.reason).toBe("capture-expired");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to publish when the file changed during rendering", () =>
    Effect.gen(function* () {
      const { root, prepared } = yield* prepare;
      yield* Effect.promise(() => writeFixtureFile(root, "notes/report.md", "# Edited\n"));
      const store = makeGeneratedDocumentStore();
      const error = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: renderResultFor(prepared.expected),
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store), Effect.flip);
      expect(error.reason).toBe("source-changed");
      expect(store.publishPdf).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails over-limit output with a clear message", () =>
    Effect.gen(function* () {
      const { prepared } = yield* prepare;
      const store = makeGeneratedDocumentStore();
      const error = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: renderResultFor(
          prepared.expected,
          {},
          new Uint8Array(BROWSER_PDF_EXPORT_MAX_BYTES + 1),
        ),
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store), Effect.flip);
      expect(error).toMatchObject({ reason: "too-large", detail: DOCUMENT_PDF_TOO_LARGE_DETAIL });
      expect(error.detail).toContain("64 MiB");
      expect(store.publishPdf).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not publish an expired capture", () =>
    Effect.gen(function* () {
      const { prepared } = yield* prepare;
      yield* TestClock.adjust("11 minutes");
      const store = makeGeneratedDocumentStore();
      const error = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: renderResultFor(prepared.expected),
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store), Effect.flip);
      expect(error.reason).toBe("capture-expired");
      expect(store.beginProduction).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );
});
