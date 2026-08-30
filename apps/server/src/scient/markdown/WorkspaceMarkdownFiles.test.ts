import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  inspectMarkdownImage,
  portableImageStem,
  uploadWorkspaceMarkdownImage,
} from "./WorkspaceMarkdownFiles.ts";

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntriesLayer),
    ),
  ),
  Layer.provideMerge(WorkspaceEntriesLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "scient-markdown-assets-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("Markdown image inspection", () => {
  it("uses signatures rather than browser-provided MIME labels", () => {
    expect(inspectMarkdownImage(PNG_BYTES)?.mediaType).toBe("image/png");
    expect(inspectMarkdownImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.mediaType).toBe(
      "image/jpeg",
    );
    expect(inspectMarkdownImage(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("builds portable, bounded file stems without discarding Unicode", () => {
    expect(portableImageStem("../תוצאה final (2).PNG")).toBe("תוצאה-final-2");
    expect(portableImageStem("...png")).toBe("image");
  });
});

it.layer(TestLayer, { excludeTestServices: true })("Markdown workspace image writes", (it) => {
  it.effect("writes sibling assets exclusively and returns portable Markdown paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-markdown-doc-" });
      const uploadDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-markdown-upload-",
      });
      const uploadPath = path.join(uploadDirectory, "figure.png");
      yield* fileSystem.writeFile(uploadPath, PNG_BYTES);

      const first = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "notes/report.md",
        temporaryPath: uploadPath,
        fileName: "Result plot.png",
      });
      const second = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "notes/report.md",
        temporaryPath: uploadPath,
        fileName: "Result plot.png",
      });

      expect(first).toMatchObject({
        relativePath: "notes/assets/Result-plot.png",
        markdownSource: "assets/Result-plot.png",
        mediaType: "image/png",
      });
      expect(second.relativePath).toBe("notes/assets/Result-plot-2.png");
      expect([...(yield* fileSystem.readFile(path.join(cwd, first.relativePath)))]).toEqual([
        ...PNG_BYTES,
      ]);
    }),
  );

  it.effect("rejects misleading extensions and unsafe asset directories before writing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-markdown-doc-" });
      const uploadDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-markdown-upload-",
      });
      const uploadPath = path.join(uploadDirectory, "figure.png");
      yield* fileSystem.writeFile(uploadPath, PNG_BYTES);

      const mismatch = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "report.md",
        temporaryPath: uploadPath,
        fileName: "figure.jpg",
      }).pipe(Effect.flip);
      const unsafeDirectory = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "report.md",
        assetDirectory: ".git",
        temporaryPath: uploadPath,
        fileName: "figure.png",
      }).pipe(Effect.flip);
      const traversalDirectory = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "report.md",
        assetDirectory: "..",
        temporaryPath: uploadPath,
        fileName: "figure.png",
      }).pipe(Effect.flip);

      expect(mismatch).toMatchObject({
        _tag: "ScientMarkdownImageInvalidError",
        reason: "media_extension_mismatch",
      });
      expect(unsafeDirectory).toMatchObject({
        _tag: "ScientMarkdownImageInvalidError",
        reason: "invalid_asset_directory",
      });
      expect(traversalDirectory).toMatchObject({
        _tag: "ScientMarkdownImageInvalidError",
        reason: "invalid_asset_directory",
      });
    }),
  );

  it.effect("rejects empty uploads and document paths outside the Markdown scope", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-markdown-doc-" });
      const uploadDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-markdown-upload-",
      });
      const emptyPath = path.join(uploadDirectory, "empty.png");
      yield* fileSystem.writeFile(emptyPath, new Uint8Array());

      const empty = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "report.md",
        temporaryPath: emptyPath,
        fileName: "empty.png",
      }).pipe(Effect.flip);
      const outsideDocument = yield* uploadWorkspaceMarkdownImage({
        cwd,
        documentRelativePath: "../report.md",
        temporaryPath: emptyPath,
        fileName: "empty.png",
      }).pipe(Effect.flip);

      expect(empty).toMatchObject({
        _tag: "ScientMarkdownImageInvalidError",
        reason: "empty_file",
      });
      expect(outsideDocument).toMatchObject({
        _tag: "ScientMarkdownImageInvalidError",
        reason: "invalid_document_path",
      });
    }),
  );
});
