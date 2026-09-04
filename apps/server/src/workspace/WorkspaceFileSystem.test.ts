// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
          revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
          revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          readOnly: true,
        });
      }),
    );

    it.effect("rejects a FIFO without blocking on open", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const fifoPath = path.join(outsideDir, "pipe");
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                error ? reject(error) : resolve(),
              ),
            ),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: fifoPath })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("marks in-workspace symlink reads as read-only", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "managed/source.txt", "managed\n");
        yield* fileSystem.symlink(
          path.join(cwd, "managed/source.txt"),
          path.join(cwd, "source-link.txt"),
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "source-link.txt",
        });

        expect(result).toMatchObject({
          relativePath: "source-link.txt",
          contents: "managed\n",
          readOnly: true,
        });
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("keeps PDF bytes out of the text readFile path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.writeFile(
          path.join(cwd, "paper.pdf"),
          Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0]),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "paper.pdf" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("watchFile", () => {
    it.effect("emits a coalesced hint only when the selected file changes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        yield* writeTextFile(cwd, "notes.txt", "unchanged\n");
        const opened = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "analysis.m",
        });

        const event = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? Effect.gen(function* () {
                    yield* writeTextFile(cwd, "notes.txt", "unrelated\n");
                    yield* workspaceFileSystem.writeFile({
                      cwd,
                      relativePath: "analysis.m",
                      contents: "answer = 2;\n",
                      expectedRevision: opened.revision,
                    });
                  })
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

        expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath: "analysis.m" }));
      }),
    );

    it.effect("emits a hint when the selected file is removed", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");

        const event = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? fileSystem.remove(path.join(cwd, "analysis.m"))
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

        expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath: "analysis.m" }));
      }),
    );

    it.effect("keeps watching a missing file so recreation can recover the viewer", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const event = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? writeTextFile(cwd, "analysis.m", "answer = 2;\n")
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

        expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath: "analysis.m" }));
      }),
    );

    it.effect("continues watching across deletion and recreation", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "analysis.m");
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        let observedChanges = 0;

        const events = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) => {
              if (event._tag === "watch-ready") return fileSystem.remove(absolutePath);
              observedChanges += 1;
              return observedChanges === 1
                ? writeTextFile(cwd, "analysis.m", "answer = 2;\n")
                : Effect.void;
            }),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.take(2),
            Stream.runCollect,
          );

        expect([...events]).toEqual([
          { _tag: "file-changed", relativePath: "analysis.m" },
          { _tag: "file-changed", relativePath: "analysis.m" },
        ]);
        expect(yield* fileSystem.readFileString(absolutePath)).toBe("answer = 2;\n");
      }),
    );

    it.effect("follows in-workspace file symlinks to their real target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "sources/analysis.m", "answer = 1;\n");
        yield* fileSystem.symlink(
          path.join(cwd, "sources/analysis.m"),
          path.join(cwd, "analysis.m"),
        );

        const event = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? writeTextFile(cwd, "sources/analysis.m", "answer = 2;\n")
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

        expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath: "analysis.m" }));
      }),
    );

    it.effect("rejects watch paths and symlink targets outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "analysis.m", "answer = 1;\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "analysis.m"),
          path.join(cwd, "analysis.m"),
        );

        const lexicalEscape = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "../analysis.m" })
          .pipe(Stream.runHead, Effect.flip);
        const symlinkEscape = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(Stream.runHead, Effect.flip);

        expect(lexicalEscape.message).toContain(
          "Workspace file path must be relative to the project root: ../analysis.m",
        );
        expect(symlinkEscape).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("creates a file exclusively without replacing an existing path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes/untitled.md",
          contents: "# First\n",
          createOnly: true,
        });
        const collision = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes/untitled.md",
            contents: "# Replacement\n",
            createOnly: true,
          })
          .pipe(Effect.flip);

        expect(collision).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "notes/untitled.md"))).toBe(
          "# First\n",
        );
      }),
    );

    it.effect("allows only one concurrent exclusive create for the same path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const results = yield* Effect.all(
          [
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "notes/race.md",
                contents: "# First\n",
                createOnly: true,
              })
              .pipe(Effect.result),
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "notes/race.md",
                contents: "# Second\n",
                createOnly: true,
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );

        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failure = results.find((result) => result._tag === "Failure");
        expect(failure?._tag).toBe("Failure");
        if (failure?._tag === "Failure") {
          expect(failure.failure).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
        }
        expect(["# First\n", "# Second\n"]).toContain(
          yield* fileSystem.readFileString(path.join(cwd, "notes/race.md")),
        );
      }),
    );

    it.effect("rejects new-file writes through a symlinked parent outside the workspace", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* fileSystem.symlink(outside, path.join(cwd, "linked"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked/escape.md",
            contents: "# Escape\n",
            createOnly: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(
          yield* fileSystem.stat(path.join(outside, "escape.md")).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects new files through a directory symlink outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "outside-link/created.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(
          yield* fileSystem.stat(path.join(outside, "created.md")).pipe(Effect.option),
        ).toEqual(Option.none());
      }),
    );

    it.effect("refuses to overwrite a file that changed after it was opened", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        yield* fileSystem.writeFileString(path.join(cwd, "analysis.m"), "answer = 2;\n");
        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "analysis.m",
            contents: "answer = 3;\n",
            expectedRevision: opened.revision,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({ relativePath: "analysis.m" });
        expect(yield* fileSystem.readFileString(path.join(cwd, "analysis.m"))).toBe(
          "answer = 2;\n",
        );
      }),
    );

    it.effect("does not recreate a file deleted after it was opened", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "deleted.md");
        yield* writeTextFile(cwd, "deleted.md", "# Before\n");
        const opened = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "deleted.md",
        });
        yield* fileSystem.remove(absolutePath);

        const result = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "deleted.md",
            contents: "# Local\n",
            expectedRevision: opened.revision,
          })
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        expect(
          yield* fileSystem.stat(absolutePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    );

    it.effect("returns the revision produced by a conditional atomic write", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        const written = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "analysis.m",
          contents: "answer = 2;\n",
          expectedRevision: opened.revision,
        });
        const reread = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        expect(written.revision).toBe(reread.revision);
        expect(reread.contents).toBe("answer = 2;\n");
      }),
    );

    it.effect("converges an identical conditional retry without replacing the file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const relativePath = "notes.md";
        const absolutePath = path.join(cwd, relativePath);
        yield* writeTextFile(cwd, relativePath, "# Before\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath });
        const contents = "# שלום 😀\r\nCafé and café\r\n";
        const first = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath,
          contents,
          expectedRevision: opened.revision,
        });
        if ((yield* HostProcessPlatform) !== "win32") {
          yield* fileSystem.chmod(absolutePath, 0o751);
        }
        yield* fileSystem.utimes(absolutePath, 1_000_000, 1_000_000);
        const beforeRetry = yield* fileSystem.stat(absolutePath);

        const retry = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath,
          contents,
          expectedRevision: opened.revision,
        });
        const afterRetry = yield* fileSystem.stat(absolutePath);

        expect(retry).toEqual(first);
        expect(afterRetry.ino).toEqual(beforeRetry.ino);
        expect(afterRetry.mtime).toEqual(beforeRetry.mtime);
        expect(afterRetry.mode).toBe(beforeRetry.mode);
        expect(Array.from(yield* fileSystem.readFile(absolutePath))).toEqual(
          Array.from(new TextEncoder().encode(contents)),
        );
      }),
    );

    it.effect("uses raw byte revisions rather than decoded text to establish convergence", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const relativePath = "notes.md";
        const absolutePath = path.join(cwd, relativePath);
        yield* writeTextFile(cwd, relativePath, "Before");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath });
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0xff]));
        const current = yield* workspaceFileSystem.readFile({ cwd, relativePath });
        expect(current.contents).toBe("�");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath,
            contents: current.contents,
            expectedRevision: opened.revision,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(Array.from(yield* fileSystem.readFile(absolutePath))).toEqual([0xff]);
      }),
    );

    it.effect("refreshes workspace entries when an already-published retry converges", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "existing.md", "# Existing\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "existing.md" });
        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "published.md")).toBe(false);
        // Simulate publication completing before its index refresh/response.
        yield* writeTextFile(cwd, "published.md", "# Published\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "published.md",
          contents: "# Published\n",
          expectedRevision: opened.revision,
        });

        const afterRetry = yield* workspaceEntries.list({ cwd });
        expect(afterRetry.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "published.md" })]),
        );
      }),
    );

    it.effect("never treats an identical exclusive create as a convergent retry", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Existing\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: opened.contents,
            expectedRevision: opened.revision,
            createOnly: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
      }),
    );

    it.effect("never converges against the matching prefix of a truncated file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const contents = "x".repeat(1024 * 1024 + 1);
        yield* writeTextFile(cwd, "large.md", contents);
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.md" });
        expect(opened.truncated).toBe(true);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "large.md",
            contents: opened.contents,
            expectedRevision: opened.revision,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "large.md"))).toBe(contents);
      }),
    );

    it.effect("converges concurrent conditional writes requesting identical bytes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Before\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
        const input = {
          cwd,
          relativePath: "notes.md",
          contents: "# After\n",
          expectedRevision: opened.revision,
        };

        const results = yield* Effect.all(
          [workspaceFileSystem.writeFile(input), workspaceFileSystem.writeFile(input)],
          { concurrency: 2 },
        );

        expect(results[0]).toEqual(results[1]);
        const after = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
        expect(after.contents).toBe(input.contents);
        expect(after.revision).toBe(results[0]?.revision);
      }),
    );

    it.effect("allows only one concurrent write against the same source revision", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        const results = yield* Effect.all(
          [
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "analysis.m",
                contents: "answer = 2;\n",
                expectedRevision: opened.revision,
              })
              .pipe(Effect.result),
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "analysis.m",
                contents: "answer = 3;\n",
                expectedRevision: opened.revision,
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );

        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failure = results.find((result) => result._tag === "Failure");
        expect(failure?._tag).toBe("Failure");
        if (failure?._tag === "Failure") {
          expect(failure.failure).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFileRevisionConflictError,
          );
        }
      }),
    );

    it.effect("preserves executable permissions when atomically replacing a source file", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const sourcePath = path.join(cwd, "analysis.m");
        yield* writeTextFile(cwd, "analysis.m", "answer = 1;\n");
        yield* fileSystem.chmod(sourcePath, 0o755);
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "analysis.m",
          contents: "answer = 2;\n",
          expectedRevision: opened.revision,
        });

        expect((yield* fileSystem.stat(sourcePath)).mode & 0o777).toBe(0o755);
      }),
    );

    it.effect("preserves in-project symlinks when conditionally saving their target", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const targetPath = path.join(cwd, "src", "analysis.m");
        const linkPath = path.join(cwd, "analysis.m");
        yield* writeTextFile(cwd, "src/analysis.m", "answer = 1;\n");
        yield* fileSystem.symlink(targetPath, linkPath);
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "analysis.m" });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "analysis.m",
          contents: "answer = 2;\n",
          expectedRevision: opened.revision,
        });

        expect(yield* fileSystem.readLink(linkPath)).toBe(targetPath);
        expect(yield* fileSystem.readFileString(targetPath)).toBe("answer = 2;\n");
      }),
    );
  });

  describe("renameFile", () => {
    for (const aliasKind of ["root", "parent"] as const) {
      it.effect(`serializes saves and renames through a ${aliasKind} alias`, () =>
        Effect.gen(function* () {
          if ((yield* HostProcessPlatform) === "win32") return;
          const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* makeTempDir;
          const cwd = yield* fileSystem.realPath(temporaryRoot);
          const actualRoot = path.join(cwd, "actual");
          const aliasRoot = path.join(cwd, "alias");
          yield* fileSystem.makeDirectory(actualRoot);
          yield* fileSystem.symlink(actualRoot, aliasRoot);

          for (let round = 0; round < 25; round += 1) {
            const relativePath = `${round}.md`;
            const destinationRelativePath = `${round}-renamed.md`;
            const baseline = yield* api.writeFile({
              cwd: actualRoot,
              relativePath,
              contents: "before",
            });
            const [edit, rename] = yield* Effect.all(
              [
                api
                  .writeFile({
                    cwd: actualRoot,
                    relativePath,
                    contents: "edited 😀",
                    expectedRevision: baseline.revision,
                  })
                  .pipe(Effect.result),
                api
                  .renameFile({
                    cwd: aliasKind === "root" ? aliasRoot : cwd,
                    relativePath: aliasKind === "root" ? relativePath : `alias/${relativePath}`,
                    destinationRelativePath:
                      aliasKind === "root"
                        ? destinationRelativePath
                        : `alias/${destinationRelativePath}`,
                    expectedRevision: baseline.revision,
                  })
                  .pipe(Effect.result),
              ],
              { concurrency: 2 },
            );

            expect([edit, rename].filter((result) => result._tag === "Success")).toHaveLength(1);
            if (edit._tag === "Success") {
              const saved = yield* api.readFile({ cwd: actualRoot, relativePath });
              expect(saved.contents).toBe("edited 😀");
              expect(saved.revision).toBe(edit.success.revision);
              expect(yield* fileSystem.exists(path.join(actualRoot, destinationRelativePath))).toBe(
                false,
              );
            } else {
              expect(rename._tag).toBe("Success");
              const moved = yield* api.readFile({
                cwd: actualRoot,
                relativePath: destinationRelativePath,
              });
              expect(moved.contents).toBe("before");
              expect(moved.revision).toBe(baseline.revision);
              expect(yield* fileSystem.exists(path.join(actualRoot, relativePath))).toBe(false);
            }
          }
        }),
      );
    }

    it.effect("rejects a rename onto the same canonical file through an alias", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "actual/source.md", "unchanged");
        yield* fileSystem.symlink(path.join(cwd, "actual"), path.join(cwd, "alias"));
        const baseline = yield* api.readFile({ cwd, relativePath: "actual/source.md" });
        const error = yield* api
          .renameFile({
            cwd,
            relativePath: "actual/source.md",
            destinationRelativePath: "alias/source.md",
            expectedRevision: baseline.revision,
          })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
        expect((yield* api.readFile({ cwd, relativePath: "actual/source.md" })).contents).toBe(
          "unchanged",
        );
      }),
    );

    it.effect("renames only the expected revision and never replaces a destination", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/draft.md", "# Draft\n");
        const opened = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/draft.md",
        });

        const renamed = yield* workspaceFileSystem.renameFile({
          cwd,
          relativePath: "notes/draft.md",
          destinationRelativePath: "papers/final.md",
          expectedRevision: opened.revision,
        });
        expect(renamed).toEqual({
          relativePath: "notes/draft.md",
          destinationRelativePath: "papers/final.md",
          revision: opened.revision,
        });
        expect(yield* fileSystem.readFileString(path.join(cwd, "papers/final.md"))).toBe(
          "# Draft\n",
        );
        expect(
          yield* fileSystem.stat(path.join(cwd, "notes/draft.md")).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);

        yield* writeTextFile(cwd, "notes/second.md", "# Second\n");
        const second = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/second.md",
        });
        const collision = yield* workspaceFileSystem
          .renameFile({
            cwd,
            relativePath: "notes/second.md",
            destinationRelativePath: "papers/final.md",
            expectedRevision: second.revision,
          })
          .pipe(Effect.flip);
        expect(collision).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "notes/second.md"))).toBe(
          "# Second\n",
        );
        expect(yield* fileSystem.readFileString(path.join(cwd, "papers/final.md"))).toBe(
          "# Draft\n",
        );
      }),
    );

    it.effect("refuses a rename after an external content change", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "draft.md", "# One\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "draft.md" });
        yield* fileSystem.writeFileString(path.join(cwd, "draft.md"), "# Two\n");

        const error = yield* workspaceFileSystem
          .renameFile({
            cwd,
            relativePath: "draft.md",
            destinationRelativePath: "final.md",
            expectedRevision: opened.revision,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "draft.md"))).toBe("# Two\n");
        expect(
          yield* fileSystem.stat(path.join(cwd, "final.md")).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    );

    it.effect("allows only one concurrent rename of the same source", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "draft.md", "# Draft\n");
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "draft.md" });

        const results = yield* Effect.all(
          [
            workspaceFileSystem
              .renameFile({
                cwd,
                relativePath: "draft.md",
                destinationRelativePath: "final-a.md",
                expectedRevision: opened.revision,
              })
              .pipe(Effect.result),
            workspaceFileSystem
              .renameFile({
                cwd,
                relativePath: "draft.md",
                destinationRelativePath: "final-b.md",
                expectedRevision: opened.revision,
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );

        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const existingDestinations: string[] = [];
        for (const relativePath of ["final-a.md", "final-b.md"]) {
          const exists = yield* fileSystem.stat(path.join(cwd, relativePath)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (exists) existingDestinations.push(relativePath);
        }
        expect(existingDestinations).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(cwd, existingDestinations[0]!))).toBe(
          "# Draft\n",
        );
        expect(
          yield* fileSystem.stat(path.join(cwd, "draft.md")).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    );
  });
});
