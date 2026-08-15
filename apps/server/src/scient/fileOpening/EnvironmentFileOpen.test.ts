import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { classifyEnvironmentFile, prepareEnvironmentFileOpen } from "./EnvironmentFileOpen.ts";

const TestLayer = NodeServices.layer;
const bytes = (value: string) => new TextEncoder().encode(value);

describe("EnvironmentFileOpen", () => {
  it.each([
    ["paper.data", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), "pdf"],
    ["figure.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image"],
    ["figure.svg", bytes('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>'), "image"],
    ["report.html", bytes("<html><body><button>Run</button></body></html>"), "html"],
    ["malformed.HTML", bytes("<div>unfinished"), "html"],
    ["README.md", bytes("# Results\n\n$E = mc^2$"), "markdown"],
    ["component.tsx", bytes("export const Figure = () => <svg />;"), "text"],
    ["recording.mp3", new Uint8Array([0x49, 0x44, 0x33]), "audio"],
    ["experiment.webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "video"],
    ["archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), "binary"],
  ] as const)("classifies %s as %s", (filePath, sample, expectedKind) => {
    expect(classifyEnvironmentFile({ filePath, bytes: sample }).kind).toBe(expectedKind);
  });

  it("detects UTF-16 text without treating its NUL bytes as binary", () => {
    const sample = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
    expect(classifyEnvironmentFile({ filePath: "notes.txt", bytes: sample })).toMatchObject({
      kind: "text",
      textEncoding: "utf-16le",
    });
  });

  it("does not misclassify a bounded UTF-8 sample that ends inside a character", () => {
    const partialEuro = new Uint8Array([0x41, 0xe2, 0x82]);
    expect(
      classifyEnvironmentFile({
        filePath: "large-report.txt",
        bytes: partialEuro,
        sampleTruncated: true,
      }).kind,
    ).toBe("text");
    expect(
      classifyEnvironmentFile({ filePath: "corrupt-report.txt", bytes: partialEuro }).kind,
    ).toBe("binary");
  });

  it.effect("canonicalizes, inspects, and samples a real file through a scoped handle", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-open-" });
      const realFile = path.join(root, "reports", "result.tsx");
      const linkedFile = path.join(root, "linked-result.tsx");
      const contents = "export function Result() { return <div>42</div>; }\n";
      yield* fileSystem.makeDirectory(path.dirname(realFile), { recursive: true });
      yield* fileSystem.writeFileString(realFile, contents);
      yield* fileSystem.symlink(realFile, linkedFile);

      const prepared = yield* prepareEnvironmentFileOpen({
        path: EnvironmentFilePath.make(linkedFile),
      });

      expect(prepared.canonicalPath).toBe(yield* fileSystem.realPath(realFile));
      expect(prepared.fileName).toBe("result.tsx");
      expect(prepared.byteLength).toBe(bytes(contents).byteLength);
      expect(prepared.mtimeMs).toEqual(expect.any(Number));
      expect(prepared.presentation).toMatchObject({ kind: "text" });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("reports stable failure categories for relative, missing, and directory paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-errors-" });

      const relative = yield* Effect.flip(
        prepareEnvironmentFileOpen({ path: EnvironmentFilePath.make("notes.txt") }),
      );
      expect(relative.failure).toBe("path_not_absolute");

      const missing = yield* Effect.flip(
        prepareEnvironmentFileOpen({
          path: EnvironmentFilePath.make(path.join(root, "missing.txt")),
        }),
      );
      expect(missing.failure).toBe("not_found");

      const directory = yield* Effect.flip(
        prepareEnvironmentFileOpen({ path: EnvironmentFilePath.make(root) }),
      );
      expect(directory.failure).toBe("not_a_file");
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("maps host permission failures to the stable unreadable contract", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: "/restricted/paper.pdf",
      });
      const unreadableFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });
      const error = yield* prepareEnvironmentFileOpen({
        path: EnvironmentFilePath.make("/restricted/paper.pdf"),
      }).pipe(Effect.provideService(FileSystem.FileSystem, unreadableFileSystem), Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentFilePrepareError",
        failure: "unreadable",
        path: "/restricted/paper.pdf",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("bounds inspection work for large text files without changing reported size", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-large-" });
      const filePath = path.join(root, "long-report.md");
      const contents = `# Long report\n${"measurement,42\n".repeat(20_000)}`;
      yield* fileSystem.writeFileString(filePath, contents);

      const prepared = yield* prepareEnvironmentFileOpen({
        path: EnvironmentFilePath.make(filePath),
      });
      expect(prepared.byteLength).toBe(bytes(contents).byteLength);
      expect(prepared.presentation.kind).toBe("markdown");
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});
