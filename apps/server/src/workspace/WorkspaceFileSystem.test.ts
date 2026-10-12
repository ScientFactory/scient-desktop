// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

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
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { filePublicationTestHelper } from "../scient/workspace/fileExchange.testkit.ts";
const publicationHelper = await filePublicationTestHelper();

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-files-test-" });
        const canonical = yield* fs.realPath(directory);
        return ServerConfig.layerTest(
          process.cwd(),
          canonical,
          publicationHelper === undefined ? {} : { filePublicationHelperPath: publicationHelper },
        );
      }),
    ),
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

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
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

    // Windows cannot hold a file name that ends in a space.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "reads the file a path names when a sibling differs only by a trailing space",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "notes.md", "plain\n");
          yield* writeTextFile(cwd, "notes.md ", "spaced\n");

          const spaced = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md " });
          const plain = yield* workspaceFileSystem.readFile({ cwd, relativePath: "notes.md" });
          const absolute = yield* workspaceFileSystem.viewFile({
            cwd,
            relativePath: path.join(cwd, "notes.md "),
          });

          expect([spaced.relativePath, spaced.contents]).toEqual(["notes.md ", "spaced\n"]);
          expect([plain.relativePath, plain.contents]).toEqual(["notes.md", "plain\n"]);
          expect(absolute.contents).toBe("spaced\n");
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
          outsideWorkspace: true,
        });

        // An absolute spelling of a workspace file is read-only for being
        // addressed that way; it is not outside the workspace.
        yield* writeTextFile(cwd, "inside.md", "# Inside\n");
        const inside = yield* workspaceFileSystem.viewFile({
          cwd,
          relativePath: path.join(cwd, "inside.md"),
        });
        expect(inside.readOnly).toBe(true);
        expect(inside).not.toHaveProperty("outsideWorkspace");
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
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

    it.effect("refuses relative traversal to an existing outside file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const cwd = path.join(root, "project");
        yield* writeTextFile(cwd, "inside.md", "inside");
        yield* writeTextFile(root, "escape.md", "outside");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(error).toMatchObject({ workspaceRoot: cwd, relativePath: "../escape.md" });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
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

    // Viewing never depends on the project boundary: through viewFile the same
    // outside file reads identically whichever way the path is spelled, and
    // never editably. readFile, which everything else uses, still refuses.
    it.effect("reads an outside file read-only through a path that climbs out of the root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "review-notes.md", "# Notes\n");
        const absolutePath = path.join(outsideDir, "review-notes.md");
        const climbingPath = path.relative(cwd, absolutePath);
        expect(climbingPath.startsWith("..")).toBe(true);

        const byAbsolutePath = yield* workspaceFileSystem.viewFile({
          cwd,
          relativePath: absolutePath,
        });
        const byClimbingPath = yield* workspaceFileSystem.viewFile({
          cwd,
          relativePath: climbingPath,
        });

        expect(byClimbingPath).toEqual({ ...byAbsolutePath, relativePath: climbingPath });
        expect(byClimbingPath).toMatchObject({ contents: "# Notes\n", readOnly: true });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads a symlink that leads out of the root as its target, read-only",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "notes.txt", "outside\n");
          const absolutePath = path.join(outsideDir, "notes.txt");
          yield* fileSystem.symlink(absolutePath, path.join(cwd, "linked-notes.txt"));

          const byAbsolutePath = yield* workspaceFileSystem.viewFile({
            cwd,
            relativePath: absolutePath,
          });
          const bySymlink = yield* workspaceFileSystem.viewFile({
            cwd,
            relativePath: "linked-notes.txt",
          });

          expect(bySymlink).toEqual({ ...byAbsolutePath, relativePath: "linked-notes.txt" });
          expect(bySymlink).toMatchObject({ contents: "outside\n", readOnly: true });
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
        // Read-only for being reached through a link, not for where it lives.
        expect(result).not.toHaveProperty("outsideWorkspace");
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

        const event = yield* workspaceFileSystem
          .watchFile({ cwd, relativePath: "analysis.m" })
          .pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? Effect.gen(function* () {
                    yield* writeTextFile(cwd, "notes.txt", "unrelated\n");
                    yield* writeTextFile(cwd, "analysis.m", "answer = 2;\n");
                  })
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

        expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath: "analysis.m" }));
      }),
    );

    // Windows cannot hold a file name that ends in a space.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "watches the file a path names, not a sibling without its trailing space",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "notes.md", "plain\n");
          yield* writeTextFile(cwd, "notes.md ", "spaced\n");

          // Workspace-relative and absolute spellings both name the spaced file.
          for (const relativePath of ["notes.md ", path.join(cwd, "notes.md ")]) {
            const events = yield* workspaceFileSystem.watchFile({ cwd, relativePath }).pipe(
              Stream.tap((event) =>
                event._tag === "watch-ready"
                  ? Effect.gen(function* () {
                      // The trimmed sibling changes first: watching it would report here.
                      yield* writeTextFile(cwd, "notes.md", "plain, edited\n");
                      yield* Effect.sleep("250 millis");
                      yield* writeTextFile(cwd, "notes.md ", "spaced, edited\n");
                    })
                  : Effect.void,
              ),
              Stream.filter((event) => event._tag === "file-changed"),
              Stream.take(1),
              Stream.runCollect,
            );
            expect([...events]).toEqual([{ _tag: "file-changed", relativePath }]);
            expect(yield* workspaceFileSystem.viewFile({ cwd, relativePath })).toMatchObject({
              contents: "spaced, edited\n",
            });
            yield* writeTextFile(cwd, "notes.md ", "spaced\n");
          }
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

    it.effect("watches files outside the workspace however the path is spelled", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "analysis.m", "answer = 1;\n");
        const absolutePath = path.join(outsideDir, "analysis.m");
        const spellings = [absolutePath, path.relative(cwd, absolutePath)];
        if (symlinksSupported) {
          yield* fileSystem.symlink(absolutePath, path.join(cwd, "analysis.m"));
          spellings.push("analysis.m");
        }

        for (const [index, relativePath] of spellings.entries()) {
          const event = yield* workspaceFileSystem.watchFile({ cwd, relativePath }).pipe(
            Stream.tap((event) =>
              event._tag === "watch-ready"
                ? writeTextFile(outsideDir, "analysis.m", `answer = ${index + 2};\n`)
                : Effect.void,
            ),
            Stream.filter((event) => event._tag === "file-changed"),
            Stream.runHead,
          );

          expect(event).toEqual(Option.some({ _tag: "file-changed", relativePath }));
        }
      }),
    );
  });

  describe("writeFile", () => {
    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
      "saves changed bytes through the real workspace service",
      () =>
        Effect.gen(function* () {
          const api = yield* WorkspaceFileSystem.WorkspaceFileSystem,
            fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "main.tex", "A");
          const original = yield* api.readFile({ cwd, relativePath: "main.tex" });
          const result = yield* api.writeFile({
            cwd,
            relativePath: "main.tex",
            contents: "C",
            expectedRevision: original.revision,
            mutationId: "ordinary-save",
          });
          expect(result.revision).toBe(
            `sha256:${NodeCrypto.createHash("sha256").update("C").digest("hex")}`,
          );
          expect(yield* fs.readFileString(path.join(cwd, "main.tex"))).toBe("C");
        }),
    );
    it.effect("creates exclusively, or refuses unsupported host authority before creation", () =>
      Effect.gen(function* () {
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem,
          fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const result = yield* api
          .writeFile({
            cwd,
            relativePath: "nested/main.tex",
            contents: "A",
            createOnly: true,
            mutationId: "create",
          })
          .pipe(Effect.result);
        if ((yield* HostProcessPlatform) !== "darwin") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              _tag: "WorkspaceFileMutationUnavailableError",
              publicationOutcome: "unchanged",
            });
          expect(yield* fs.exists(path.join(cwd, "nested"))).toBe(false);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(yield* fs.readFileString(path.join(cwd, "nested/main.tex"))).toBe("A");
        const refused = yield* api
          .writeFile({
            cwd,
            relativePath: "nested/main.tex",
            contents: "B",
            createOnly: true,
            mutationId: "other",
          })
          .pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        if (refused._tag === "Failure")
          expect(refused.failure).toMatchObject({ _tag: "WorkspaceFileExistsError" });
        expect(yield* fs.readFileString(path.join(cwd, "nested/main.tex"))).toBe("A");
      }),
    );
    it.effect("rejects absolute and escaping targets without creating an outside file", () =>
      Effect.gen(function* () {
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem,
          fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const cwd = yield* makeTempDir,
          outside = yield* makeTempDir;
        const absolute = yield* api
          .writeFile({ cwd, relativePath: path.join(outside, "main.tex"), contents: "C" })
          .pipe(Effect.result);
        expect(absolute._tag).toBe("Failure");
        const escaping = yield* api
          .writeFile({ cwd, relativePath: "../escape.tex", contents: "C" })
          .pipe(Effect.result);
        expect(escaping._tag).toBe("Failure");
        expect(yield* fs.exists(path.join(outside, "main.tex"))).toBe(false);
      }),
    );
  });

  describe("renameFile", () => {
    it.effect.each(
      (["root", "parent"] as const).map((aliasKind) => ({
        caseTitle: `serializes saves and renames through a ${aliasKind} alias`,
        aliasKind,
      })),
    )("$caseTitle", ({ aliasKind }) =>
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

        for (let round = 0; round < 3; round += 1) {
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

    it.effect("renames a file it cannot read whole without a revision, never replacing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3]);
        yield* fileSystem.writeFile(path.join(cwd, "figure.pdf"), bytes);
        yield* writeTextFile(cwd, "taken.pdf", "keep");

        const refused = yield* workspaceFileSystem
          .renameFile({ cwd, relativePath: "figure.pdf", destinationRelativePath: "taken.pdf" })
          .pipe(Effect.flip);
        expect(refused).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileExistsError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "taken.pdf"))).toBe("keep");

        const renamed = yield* workspaceFileSystem.renameFile({
          cwd,
          relativePath: "figure.pdf",
          destinationRelativePath: "figures/final.pdf",
        });
        expect(renamed.destinationRelativePath).toBe("figures/final.pdf");
        expect(renamed.revision).toMatch(/^sha256:/u);
        expect([...(yield* fileSystem.readFile(path.join(cwd, "figures/final.pdf")))]).toEqual([
          ...bytes,
        ]);
        expect(
          yield* fileSystem.stat(path.join(cwd, "figure.pdf")).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).toBe(false);
      }),
    );

    it.effect("renames a truncated text file without a revision, reporting its leading bytes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const contents = "x".repeat(1024 * 1024 + 4096);
        yield* writeTextFile(cwd, "big.log", contents);
        const opened = yield* workspaceFileSystem.readFile({ cwd, relativePath: "big.log" });
        expect(opened.truncated).toBe(true);

        const renamed = yield* workspaceFileSystem.renameFile({
          cwd,
          relativePath: "big.log",
          destinationRelativePath: "big-renamed.log",
        });
        const leading = new TextEncoder().encode(contents).subarray(0, 1024 * 1024);
        expect(renamed.revision).toBe(
          `sha256:${NodeCrypto.createHash("sha256").update(leading).digest("hex")}`,
        );
        expect(renamed.revision).toBe(opened.revision);
        expect(yield* fileSystem.readFileString(path.join(cwd, "big-renamed.log"))).toBe(contents);
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
    it.effect("removes the folders a move leaves empty when asked", () =>
      Effect.gen(function* () {
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "thesis/chapters/introduction.tex", "intro");
        yield* writeTextFile(cwd, "thesis/main.tex", "main");

        const intro = yield* api.readFile({
          cwd,
          relativePath: "thesis/chapters/introduction.tex",
        });
        yield* api.renameFile({
          cwd,
          relativePath: "thesis/chapters/introduction.tex",
          destinationRelativePath: "spectral-gaps/chapters/introduction.tex",
          expectedRevision: intro.revision,
          removeEmptyFolders: true,
        });
        expect(yield* fileSystem.exists(path.join(cwd, "thesis/chapters"))).toBe(false);
        // Still holds main.tex.
        expect(yield* fileSystem.exists(path.join(cwd, "thesis"))).toBe(true);

        const main = yield* api.readFile({ cwd, relativePath: "thesis/main.tex" });
        yield* api.renameFile({
          cwd,
          relativePath: "thesis/main.tex",
          destinationRelativePath: "spectral-gaps/main.tex",
          expectedRevision: main.revision,
          removeEmptyFolders: true,
        });
        expect(yield* fileSystem.exists(path.join(cwd, "thesis"))).toBe(false);
        expect(yield* fileSystem.readFileString(path.join(cwd, "spectral-gaps/main.tex"))).toBe(
          "main",
        );
      }),
    );
  });
  describe("deleteFile", () => {
    it.effect("deletes only the revision the client read", () =>
      Effect.gen(function* () {
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/draft.tex", "first");
        const opened = yield* api.readFile({ cwd, relativePath: "notes/draft.tex" });
        yield* writeTextFile(cwd, "notes/draft.tex", "edited elsewhere");

        const error = yield* api
          .deleteFile({ cwd, relativePath: "notes/draft.tex", expectedRevision: opened.revision })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(yield* fileSystem.readFileString(path.join(cwd, "notes/draft.tex"))).toBe(
          "edited elsewhere",
        );

        const current = yield* api.readFile({ cwd, relativePath: "notes/draft.tex" });
        const deleted = yield* api.deleteFile({
          cwd,
          relativePath: "notes/draft.tex",
          expectedRevision: current.revision,
        });
        expect(deleted).toEqual({ relativePath: "notes/draft.tex" });
        expect(yield* fileSystem.exists(path.join(cwd, "notes/draft.tex"))).toBe(false);
        // Folders stay unless asked for.
        expect(yield* fileSystem.exists(path.join(cwd, "notes"))).toBe(true);
      }),
    );

    it.effect("removes the folders a file leaves empty, never the root or a folder in use", () =>
      Effect.gen(function* () {
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "thesis/chapters/introduction.tex", "intro");
        yield* writeTextFile(cwd, "thesis/main.tex", "main");
        yield* writeTextFile(cwd, "only/deep/file.tex", "alone");

        const intro = yield* api.readFile({
          cwd,
          relativePath: "thesis/chapters/introduction.tex",
        });
        yield* api.deleteFile({
          cwd,
          relativePath: "thesis/chapters/introduction.tex",
          expectedRevision: intro.revision,
          removeEmptyFolders: true,
        });
        expect(yield* fileSystem.exists(path.join(cwd, "thesis/chapters"))).toBe(false);
        expect(yield* fileSystem.readFileString(path.join(cwd, "thesis/main.tex"))).toBe("main");

        const alone = yield* api.readFile({ cwd, relativePath: "only/deep/file.tex" });
        yield* api.deleteFile({
          cwd,
          relativePath: "only/deep/file.tex",
          expectedRevision: alone.revision,
          removeEmptyFolders: true,
        });
        expect(yield* fileSystem.exists(path.join(cwd, "only"))).toBe(false);
        expect(yield* fileSystem.exists(cwd)).toBe(true);
      }),
    );

    it.effect("refuses a folder or a link", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const api = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "target.tex", "kept");
        const target = yield* api.readFile({ cwd, relativePath: "target.tex" });
        yield* fileSystem.symlink(path.join(cwd, "target.tex"), path.join(cwd, "link.tex"));

        const viaLink = yield* api
          .deleteFile({ cwd, relativePath: "link.tex", expectedRevision: target.revision })
          .pipe(Effect.result);
        expect(viaLink._tag).toBe("Failure");
        expect(yield* fileSystem.readFileString(path.join(cwd, "target.tex"))).toBe("kept");

        yield* fileSystem.makeDirectory(path.join(cwd, "folder"));
        const folder = yield* api
          .deleteFile({ cwd, relativePath: "folder", expectedRevision: target.revision })
          .pipe(Effect.result);
        expect(folder._tag).toBe("Failure");
        expect(yield* fileSystem.exists(path.join(cwd, "folder"))).toBe(true);
      }),
    );
  });
});
