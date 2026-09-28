// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  ScientDocumentPageInput,
  type ScientDocumentPdfPrepared,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { resolveAsset } from "../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  documentCaptureStartupSweepLayer,
  readDocumentCapture,
  removeDocumentCapture,
  sha256Digest,
} from "./DocumentCapture.ts";
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
import { captureProjectMarkdownFile, prepareMarkdownPdf } from "./MarkdownPdfPreparation.ts";
import { buildMarkdownFileBundle, readProjectMarkdownFile } from "./MarkdownFileBundle.ts";

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
          content: { _tag: "captured", path: "assets/0001.png", sha256: sha256Digest(PNG) },
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

  it.effect("resolves a symlinked file's images from the path the editor opened", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-alias-"),
      );
      const shown = new Uint8Array([...PNG, 1]);
      const target = new Uint8Array([...PNG, 2]);
      const contents = "# Alias\n\n![Plot](plot.png)\n";
      yield* Effect.promise(async () => {
        await writeFixtureFile(root, "archive/report.md", contents);
        await writeFixtureFile(root, "archive/plot.png", target);
        await writeFixtureFile(root, "notes/plot.png", shown);
        await NodeFSP.symlink(
          NodePath.join(root, "archive/report.md"),
          NodePath.join(root, "notes/report.md"),
        );
      });
      const prepared = yield* prepareMarkdownPdf({
        cwd: root,
        relativePath: "notes/report.md",
        expectedRevision: sha256Digest(new TextEncoder().encode(contents)),
      });
      expect(yield* readCapturedInput(prepared, "assets/0001.png")).toEqual(Buffer.from(shown));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("titles the capture from front matter and leaves the block to the page", () =>
    Effect.gen(function* () {
      const contents = "---\ntitle: Field notes\nauthor: Someone\n---\n\n# Heading\n";
      const { root, revision } = yield* Effect.promise(() => writeReport(contents));
      const prepared = yield* prepareMarkdownPdf({
        cwd: root,
        relativePath: "notes/report.md",
        expectedRevision: revision,
      });
      expect(prepared.title).toBe("Field notes");
      const input = decodePageInput(
        new TextDecoder().decode((yield* readCapturedInput(prepared))!),
      );
      expect(input.title).toBe("Field notes");
      expect(input.markdown).toBe(contents);
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

describe("Markdown source read", () => {
  const readWithFileChangedAfterStat = (change: (filePath: string) => Promise<void>) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-source-race-"),
      );
      const filePath = yield* Effect.promise(() =>
        writeFixtureFile(root, "report.md", "# Report\n\nSaved text.\n"),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      let changed = false;
      const racingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (candidate) =>
          fileSystem.stat(candidate).pipe(
            Effect.tap(() =>
              candidate === filePath && !changed
                ? Effect.promise(() => {
                    changed = true;
                    return change(filePath);
                  })
                : Effect.void,
            ),
          ),
      });
      const error = yield* readProjectMarkdownFile(root, "report.md").pipe(
        Effect.provideService(FileSystem.FileSystem, racingFileSystem),
        Effect.flip,
      );
      expect(changed).toBe(true);
      return error;
    });

  it.effect("refuses a same-size replacement between the check and the read", () =>
    Effect.gen(function* () {
      const error = yield* readWithFileChangedAfterStat(async (filePath) => {
        const replacement = `${filePath}.replacement`;
        await NodeFSP.writeFile(replacement, "# Report\n\nOther text.\n");
        await NodeFSP.rename(replacement, filePath);
      });
      expect(error).toMatchObject({ reason: "source-unavailable" });
      expect(error.detail).toContain("changed or could not be read");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a file that grows after the size check instead of reading it all", () =>
    Effect.gen(function* () {
      const error = yield* readWithFileChangedAfterStat((filePath) =>
        NodeFSP.appendFile(filePath, "x".repeat(4_096)),
      );
      expect(error).toMatchObject({ reason: "source-unavailable" });
    }).pipe(Effect.provide(layer)),
  );

  // Windows cannot bind an opened file to the project, so the editor's saved
  // revision is what proves the bytes read are the file the editor saved.
  describe("where the open file cannot be bound to the project", () => {
    const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(HostProcessPlatform, "win32"));

    it.effect("exports and publishes the file when its bytes are the saved revision", () =>
      Effect.gen(function* () {
        const { root, revision } = yield* Effect.promise(() => writeReport());
        const prepared = yield* onWindows(
          prepareMarkdownPdf({
            cwd: root,
            relativePath: "notes/report.md",
            expectedRevision: revision,
          }),
        );
        expect(prepared.expected.sourceDigest).toBe(revision);
        // Its workspace images are still left out, with a warning.
        expect(prepared.warnings.map((warning) => warning.message)).toContain(
          'Image "figures/plot.png" was not included because this platform cannot safely verify workspace image paths during PDF export.',
        );
        const store = makeGeneratedDocumentStore();
        const published = yield* onWindows(
          publishCapturedDocumentPdf({
            captureId: prepared.expected.captureId,
            render: renderResultFor(prepared.expected),
          }).pipe(Effect.provideService(GeneratedDocumentStore, store.store)),
        );
        expect(published.source).toEqual(publishedSource);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("refuses a file whose bytes are not the saved revision", () =>
      Effect.gen(function* () {
        const { root } = yield* Effect.promise(() => writeReport());
        const error = yield* onWindows(
          prepareMarkdownPdf({
            cwd: root,
            relativePath: "notes/report.md",
            expectedRevision: sha256Digest(new TextEncoder().encode("older")),
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "source-changed",
          detail: "The file changed while exporting. Try again.",
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("refuses a file swapped in between the check and the read", () =>
      Effect.gen(function* () {
        const contents = "# Report\n\nSaved text.\n";
        const root = yield* Effect.promise(() =>
          makeFixtureDirectory(fixtures, "scient-document-pdf-windows-race-"),
        );
        const filePath = yield* Effect.promise(() => writeFixtureFile(root, "report.md", contents));
        const fileSystem = yield* FileSystem.FileSystem;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (candidate) =>
            fileSystem
              .stat(candidate)
              .pipe(
                Effect.tap(() =>
                  candidate === filePath
                    ? Effect.promise(() => NodeFSP.writeFile(filePath, "# Report\n\nOther text.\n"))
                    : Effect.void,
                ),
              ),
        });
        const error = yield* onWindows(
          readProjectMarkdownFile(
            root,
            "report.md",
            sha256Digest(new TextEncoder().encode(contents)),
          ),
        ).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem), Effect.flip);
        expect(error).toMatchObject({ reason: "source-changed" });
      }).pipe(Effect.provide(layer)),
    );

    // Without a non-blocking open this would hang on the pipe.
    it.effect(
      "refuses a pipe swapped in for the file without blocking on it",
      () =>
        Effect.gen(function* () {
          // mkfifo exists only on the POSIX hosts that run this test.
          if ((yield* HostProcessPlatform) === "win32") return;
          const contents = "# Report\n\nSaved text.\n";
          const root = yield* Effect.promise(() =>
            makeFixtureDirectory(fixtures, "scient-document-pdf-windows-fifo-"),
          );
          const filePath = yield* Effect.promise(() =>
            writeFixtureFile(root, "report.md", contents),
          );
          const fileSystem = yield* FileSystem.FileSystem;
          const racingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (candidate) =>
              fileSystem.stat(candidate).pipe(
                Effect.tap(() =>
                  candidate === filePath
                    ? Effect.promise(async () => {
                        await NodeFSP.rm(filePath);
                        NodeChildProcess.execFileSync("mkfifo", [filePath]);
                      })
                    : Effect.void,
                ),
              ),
          });
          const error = yield* onWindows(
            readProjectMarkdownFile(
              root,
              "report.md",
              sha256Digest(new TextEncoder().encode(contents)),
            ),
          ).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem), Effect.flip);
          expect(error).toMatchObject({
            reason: "source-changed",
            detail: "The file changed while exporting. Try again.",
          });
        }).pipe(Effect.provide(layer)),
      10_000,
    );

    it.effect("refuses the agent tool's export, which has no saved revision to check", () =>
      Effect.gen(function* () {
        const { root } = yield* Effect.promise(() => writeReport());
        const error = yield* onWindows(
          captureProjectMarkdownFile({ workspaceRoot: root, relativePath: "notes/report.md" }),
        ).pipe(Effect.flip);
        expect(error.reason).toBe("source-unavailable");
        expect(error.detail).toContain("only from its editor");
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("Markdown image budget", () => {
  const bundleWithImageChangedAfterStat = (
    change: (imagePath: string) => Promise<void>,
    budget: { maxImageBytes: number; maxTotalBytes: number; maxImages: number },
  ) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-image-race-"),
      );
      const imagePath = yield* Effect.promise(async () => {
        await writeFixtureFile(root, "report.md", "![Image](image.png)\n");
        return writeFixtureFile(root, "image.png", PNG);
      });
      const file = yield* readProjectMarkdownFile(root, "report.md");
      const fileSystem = yield* FileSystem.FileSystem;
      let changed = false;
      const racingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (candidate) =>
          fileSystem.stat(candidate).pipe(
            Effect.tap(() =>
              candidate === imagePath && !changed
                ? Effect.promise(() => {
                    changed = true;
                    return change(imagePath);
                  })
                : Effect.void,
            ),
          ),
      });
      const bundle = yield* buildMarkdownFileBundle({ workspaceRoot: root, file, budget }).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFileSystem),
      );
      expect(changed).toBe(true);
      return bundle;
    });

  const bundleFor = (
    markdown: string,
    budget: { maxImageBytes: number; maxTotalBytes: number; maxImages: number },
    platform?: NodeJS.Platform,
  ) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-budget-"),
      );
      yield* Effect.promise(async () => {
        await writeFixtureFile(root, "report.md", markdown);
        await writeFixtureFile(root, "a.png", PNG);
        await writeFixtureFile(root, "b.png", PNG);
        await NodeFSP.symlink(NodePath.join(root, "a.png"), NodePath.join(root, "alias.png"));
      });
      const file = yield* readProjectMarkdownFile(root, "report.md");
      const build = buildMarkdownFileBundle({ workspaceRoot: root, file, budget });
      return yield* platform === undefined
        ? build
        : build.pipe(Effect.provideService(HostProcessPlatform, platform));
    });

  it.effect("reads one file once, however many destinations name it", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleFor(
        "![1](a.png?1) ![2](a.png?2) ![3](./a.png#x) ![4](alias.png)\n",
        { maxImageBytes: 1_000, maxTotalBytes: PNG.byteLength, maxImages: 10 },
      );
      expect(bundle.assets).toHaveLength(1);
      expect(bundle.assets[0]?.content._tag).toBe("bytes");
      expect(bundle.markdown.match(/scient-asset:image-0001/gu)).toHaveLength(4);
      expect(bundle.warnings).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps an in-workspace directory symlink readable through its canonical target", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-image-alias-"),
      );
      yield* Effect.promise(async () => {
        await writeFixtureFile(root, "report.md", "![Image](figures/image.png)\n");
        await writeFixtureFile(root, "real-images/image.png", PNG);
        await NodeFSP.symlink(NodePath.join(root, "real-images"), NodePath.join(root, "figures"));
      });
      const file = yield* readProjectMarkdownFile(root, "report.md");
      const bundle = yield* buildMarkdownFileBundle({ workspaceRoot: root, file });
      expect(bundle.assets[0]?.content).toMatchObject({ _tag: "bytes", bytes: PNG });
      expect(bundle.warnings).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails closed when the host cannot bind an opened image to the workspace", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleFor(
        "![a](a.png)\n",
        { maxImageBytes: 1_000, maxTotalBytes: 1_000, maxImages: 10 },
        "win32",
      );
      expect(bundle.assets[0]?.content).toEqual({ _tag: "unavailable", reason: "unsupported" });
      expect(bundle.warnings[0]?.message).toContain(
        "this platform cannot safely verify workspace image paths",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("holds images to the total, count, and per-image budgets before reading them", () =>
    Effect.gen(function* () {
      const total = yield* bundleFor("![a](a.png) ![b](b.png)\n", {
        maxImageBytes: 1_000,
        maxTotalBytes: PNG.byteLength + 1,
        maxImages: 10,
      });
      expect(total.assets.map((asset) => asset.content._tag)).toEqual(["bytes", "unavailable"]);
      expect(total.assets[1]?.content).toEqual({ _tag: "unavailable", reason: "too-large" });
      expect(total.warnings[0]?.message).toContain("exceed the export size limit");

      const count = yield* bundleFor("![a](a.png) ![b](b.png)\n", {
        maxImageBytes: 1_000,
        maxTotalBytes: 1_000,
        maxImages: 1,
      });
      expect(count.assets[1]?.content).toEqual({ _tag: "unavailable", reason: "too-large" });
      expect(count.warnings[0]?.message).toContain("more than 1 images");

      const single = yield* bundleFor("![a](a.png)\n", {
        maxImageBytes: PNG.byteLength - 1,
        maxTotalBytes: 1_000,
        maxImages: 10,
      });
      expect(single.assets[0]?.content).toEqual({ _tag: "unavailable", reason: "too-large" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an image that grows beyond the per-image or aggregate limit after stat", () =>
    Effect.gen(function* () {
      for (const [maxImageBytes, maxTotalBytes] of [
        [PNG.byteLength + 1, 1_000],
        [1_000, PNG.byteLength + 1],
      ] as const) {
        const bundle = yield* bundleWithImageChangedAfterStat(
          (imagePath) => NodeFSP.appendFile(imagePath, new Uint8Array(16)),
          { maxImageBytes, maxTotalBytes, maxImages: 10 },
        );
        expect(bundle.assets[0]?.content).toEqual({ _tag: "unavailable", reason: "unreadable" });
        expect(bundle.warnings).toHaveLength(1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a same-size replacement between path stat and fd open", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleWithImageChangedAfterStat(
        async (imagePath) => {
          const replacement = `${imagePath}.replacement`;
          await NodeFSP.writeFile(replacement, new Uint8Array(PNG.byteLength).fill(0x42));
          await NodeFSP.rename(replacement, imagePath);
        },
        { maxImageBytes: 1_000, maxTotalBytes: 1_000, maxImages: 10 },
      );
      expect(bundle.assets[0]?.content).toEqual({ _tag: "unavailable", reason: "unreadable" });
      expect(bundle.warnings).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an intermediate directory swapped to an outside symlink after realPath", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-directory-race-"),
      );
      const outside = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-outside-image-"),
      );
      const imagePath = yield* Effect.promise(async () => {
        await writeFixtureFile(root, "report.md", "![Image](figures/image.png)\n");
        await writeFixtureFile(outside, "image.png", new Uint8Array(PNG.byteLength).fill(0x42));
        return writeFixtureFile(root, "figures/image.png", PNG);
      });
      const file = yield* readProjectMarkdownFile(root, "report.md");
      const fileSystem = yield* FileSystem.FileSystem;
      let swapped = false;
      const racingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: (candidate) =>
          fileSystem.realPath(candidate).pipe(
            Effect.tap(() =>
              candidate === imagePath && !swapped
                ? Effect.promise(async () => {
                    swapped = true;
                    await NodeFSP.rename(
                      NodePath.join(root, "figures"),
                      NodePath.join(root, "figures-original"),
                    );
                    await NodeFSP.symlink(outside, NodePath.join(root, "figures"));
                  })
                : Effect.void,
            ),
          ),
      });
      const bundle = yield* buildMarkdownFileBundle({
        workspaceRoot: root,
        file,
        budget: {
          maxImageBytes: 1_000,
          maxTotalBytes: 1_000,
          maxImages: 10,
        },
      }).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem));
      expect(swapped).toBe(true);
      expect(bundle.assets[0]?.content).toEqual({ _tag: "unavailable", reason: "unreadable" });
      expect(bundle.warnings).toHaveLength(1);
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
          provenanceKind: "browser-export",
          validationProfile: "browser-export",
        }),
      );
      const reread = yield* readDocumentCapture(prepared.expected.captureId).pipe(Effect.flip);
      expect(reread.reason).toBe("capture-expired");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("publishes a page whose isolation refused requests, and reports them", () =>
    Effect.gen(function* () {
      const { prepared } = yield* prepare;
      const store = makeGeneratedDocumentStore();
      const published = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: { ...renderResultFor(prepared.expected), blockedRequestCount: 2 },
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store));
      expect(published.warnings.at(-1)).toEqual({
        code: "resource-unresolved",
        message: "2 web resources were not loaded.",
      });
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

  it.effect("detects a retargeted symlink even when the new target has identical contents", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeFixtureDirectory(fixtures, "scient-document-pdf-symlink-"),
      );
      const contents = "# Same text\n";
      yield* Effect.promise(async () => {
        await writeFixtureFile(root, "versions/a/report.md", contents);
        await writeFixtureFile(root, "versions/b/report.md", contents);
        await NodeFSP.symlink(NodePath.join(root, "versions/a"), NodePath.join(root, "current"));
        await NodeFSP.symlink(
          NodePath.join(root, "versions/a/report.md"),
          NodePath.join(root, "linked.md"),
        );
      });
      const revision = sha256Digest(new TextEncoder().encode(contents));
      for (const [relativePath, retarget] of [
        [
          "linked.md",
          async () => {
            await NodeFSP.rm(NodePath.join(root, "linked.md"));
            await NodeFSP.symlink(
              NodePath.join(root, "versions/b/report.md"),
              NodePath.join(root, "linked.md"),
            );
          },
        ],
        [
          "current/report.md",
          async () => {
            await NodeFSP.rm(NodePath.join(root, "current"));
            await NodeFSP.symlink(
              NodePath.join(root, "versions/b"),
              NodePath.join(root, "current"),
            );
          },
        ],
      ] as const) {
        const prepared = yield* prepareMarkdownPdf({
          cwd: root,
          relativePath,
          expectedRevision: revision,
        });
        yield* Effect.promise(retarget);
        const store = makeGeneratedDocumentStore();
        const error = yield* publishCapturedDocumentPdf({
          captureId: prepared.expected.captureId,
          render: renderResultFor(prepared.expected),
        }).pipe(Effect.provideService(GeneratedDocumentStore, store.store), Effect.flip);
        expect(error.reason, relativePath).toBe("source-changed");
        expect(store.publishPdf).not.toHaveBeenCalled();
      }
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

describe("document capture lifetime", () => {
  const capture = Effect.gen(function* () {
    const { root, revision } = yield* Effect.promise(() => writeReport());
    return yield* prepareMarkdownPdf({
      cwd: root,
      relativePath: "notes/report.md",
      expectedRevision: revision,
    });
  });
  const captureExists = (prepared: ScientDocumentPdfPrepared) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.exists(
        NodePath.join(config.stateDir, "document-exports", prepared.expected.captureId),
      );
    });

  it.effect("releases a capture the desktop refused to print", () =>
    Effect.gen(function* () {
      const prepared = yield* capture;
      yield* removeDocumentCapture(prepared.expected.captureId);
      expect(yield* captureExists(prepared)).toBe(false);
      const error = yield* readDocumentCapture(prepared.expected.captureId).pipe(Effect.flip);
      expect(error.reason).toBe("capture-expired");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sweeps captures a previous run left behind when the server starts", () =>
    Effect.gen(function* () {
      const stale = yield* capture;
      yield* TestClock.adjust("6 minutes");
      const current = yield* capture;
      // The stale capture has expired; the current one has four minutes left.
      yield* TestClock.adjust("6 minutes");
      expect(yield* captureExists(stale)).toBe(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(documentCaptureStartupSweepLayer);
          for (let attempt = 0; attempt < 100 && (yield* captureExists(stale)); attempt += 1) {
            yield* TestClock.withLive(Effect.sleep("20 millis"));
          }
        }),
      );
      expect(yield* captureExists(stale)).toBe(false);
      expect(yield* captureExists(current)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
