// @effect-diagnostics nodeBuiltinImport:off - the test swaps a file at the instant it is opened.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    lstat: vi.fn(actual.lstat),
  };
});
const native = await vi.importActual<typeof NodeFSP>("node:fs/promises");

const entriesStub = Layer.succeed(
  WorkspaceEntries.WorkspaceEntries,
  WorkspaceEntries.WorkspaceEntries.of({
    browse: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    listDirectory: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    searchContents: () => Effect.die("unused"),
    refresh: () => Effect.void,
  }),
);
const TestLayer = Layer.mergeAll(
  WorkspaceFileSystem.layer.pipe(Layer.provide(WorkspacePaths.layer), Layer.provide(entriesStub)),
  WorkspacePaths.layer,
  entriesStub,
).pipe(Layer.provideMerge(NodeServices.layer));

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(NodeFSP.open).mockImplementation(native.open);
  vi.mocked(NodeFSP.rename).mockImplementation(native.rename);
  vi.mocked(NodeFSP.lstat).mockImplementation(native.lstat as typeof NodeFSP.lstat);
  for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true });
});

describe("WorkspaceFileSystem.readFile", () => {
  // Windows has neither symlink-on-open semantics nor O_NOFOLLOW.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "does not read a file swapped for a symlink after it was resolved",
    () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const base = yield* Effect.promise(async () =>
          native.realpath(
            await native.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-swap-")),
          ),
        );
        roots.push(base);
        const workspace = NodePath.join(base, "workspace");
        const outside = NodePath.join(base, "outside.md");
        const inside = NodePath.join(workspace, "notes.md");
        yield* Effect.promise(async () => {
          await native.mkdir(workspace);
          await native.writeFile(inside, "inside\n");
          await native.writeFile(outside, "outside\n");
        });
        // Between resolving the path and opening it, the file becomes a link
        // to a file outside the workspace.
        let armed = true;
        vi.mocked(NodeFSP.open).mockImplementation(
          async (...args: Parameters<typeof native.open>) => {
            if (armed && String(args[0]) === inside) {
              armed = false;
              await native.unlink(inside);
              await native.symlink(outside, inside);
            }
            return native.open(...args);
          },
        );

        const swapped = yield* workspaceFileSystem
          .viewFile({ cwd: workspace, relativePath: "notes.md" })
          .pipe(Effect.result);

        expect(armed).toBe(false);
        // It must not return the outside file as an editable workspace file.
        expect(swapped._tag).toBe("Failure");
        // Read again, the link is resolved properly: its target, read-only.
        const reread = yield* workspaceFileSystem.viewFile({
          cwd: workspace,
          relativePath: "notes.md",
        });
        expect(reread).toMatchObject({ contents: "outside\n", readOnly: true });
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("WorkspaceFileSystem.renameFile", () => {
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "fails and keeps the source when its destination folder is swapped for a link out of the workspace",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const base = yield* Effect.promise(async () =>
          native.realpath(
            await native.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-swap-")),
          ),
        );
        roots.push(base);
        const workspace = NodePath.join(base, "workspace");
        const outside = NodePath.join(base, "outside");
        const destinationFolder = NodePath.join(workspace, "dir");
        const source = NodePath.join(workspace, "source.md");
        yield* Effect.promise(async () => {
          await native.mkdir(destinationFolder, { recursive: true });
          await native.mkdir(outside);
          await native.writeFile(source, "kept\n");
        });
        // After the rename has validated its destination, the folder becomes a
        // link out of the workspace.
        let armed = true;
        const swapping = FileSystem.FileSystem.of({
          ...fileSystem,
          makeDirectory: (directory, options) =>
            Effect.gen(function* () {
              if (armed && directory === destinationFolder) {
                armed = false;
                yield* Effect.promise(async () => {
                  await native.rename(destinationFolder, NodePath.join(workspace, "parked"));
                  await native.symlink(outside, destinationFolder);
                });
              }
              return yield* fileSystem.makeDirectory(directory, options);
            }),
        });
        const workspaceFileSystem = yield* WorkspaceFileSystem.make.pipe(
          Effect.provideService(FileSystem.FileSystem, swapping),
        );
        const original = yield* workspaceFileSystem.readFile({
          cwd: workspace,
          relativePath: "source.md",
        });

        const renamed = yield* workspaceFileSystem
          .renameFile({
            cwd: workspace,
            relativePath: "source.md",
            destinationRelativePath: "dir/moved.md",
            expectedRevision: original.revision,
          })
          .pipe(Effect.result, Effect.provideService(FileSystem.FileSystem, swapping));

        expect(armed).toBe(false);
        // The rename's own check of its destination must not accept a file
        // that landed outside the workspace, and the source must survive.
        expect(renamed._tag).toBe("Failure");
        expect(yield* Effect.promise(() => native.readFile(source, "utf8"))).toBe("kept\n");
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("WorkspaceFileSystem.deleteFile", () => {
  const workspaceOf = Effect.promise(async () => {
    const base = await native.realpath(
      await native.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-swap-")),
    );
    roots.push(base);
    const workspace = NodePath.join(base, "workspace");
    await native.mkdir(workspace);
    return { base, workspace };
  });

  it.effect("keeps a file another program rewrote just before its removal", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const { workspace } = yield* workspaceOf;
      const file = NodePath.join(workspace, "chapter.tex");
      yield* Effect.promise(() => native.writeFile(file, "as made\n"));
      const read = yield* workspaceFileSystem.readFile({
        cwd: workspace,
        relativePath: "chapter.tex",
      });
      // After every check, at the moment the file is taken aside, an editor
      // rewrites it in place.
      let armed = true;
      vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
        if (armed && String(from) === file) {
          armed = false;
          await native.writeFile(file, "edited elsewhere\n");
        }
        return native.rename(from, to);
      });

      const result = yield* workspaceFileSystem
        .deleteFile({
          cwd: workspace,
          relativePath: "chapter.tex",
          expectedRevision: read.revision,
        })
        .pipe(Effect.result);

      expect(armed).toBe(false);
      expect(result._tag).toBe("Failure");
      expect(yield* Effect.promise(() => native.readFile(file, "utf8"))).toBe("edited elsewhere\n");
      // Nothing is left aside.
      expect(yield* Effect.promise(() => native.readdir(workspace))).toEqual(["chapter.tex"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "stops removing empty folders at one swapped for a link out of the workspace",
    () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const { base, workspace } = yield* workspaceOf;
        const folder = NodePath.join(workspace, "thesis", "chapters");
        const outside = NodePath.join(base, "outside");
        yield* Effect.promise(async () => {
          await native.mkdir(folder, { recursive: true });
          await native.mkdir(NodePath.join(outside, "chapters"), { recursive: true });
          await native.writeFile(NodePath.join(folder, "intro.tex"), "intro\n");
        });
        const read = yield* workspaceFileSystem.readFile({
          cwd: workspace,
          relativePath: "thesis/chapters/intro.tex",
        });
        // Once the file is gone, `thesis` becomes a link to a folder outside
        // that has an empty `chapters` of its own.
        let armed = true;
        vi.mocked(NodeFSP.lstat).mockImplementation((async (target: string, options?: object) => {
          if (armed && String(target) === folder) {
            armed = false;
            await native.rm(NodePath.join(workspace, "thesis"), { recursive: true });
            await native.symlink(outside, NodePath.join(workspace, "thesis"));
          }
          return native.lstat(target, options as never);
        }) as typeof NodeFSP.lstat);

        yield* workspaceFileSystem.deleteFile({
          cwd: workspace,
          relativePath: "thesis/chapters/intro.tex",
          expectedRevision: read.revision,
          removeEmptyFolders: true,
        });

        expect(armed).toBe(false);
        expect(
          yield* Effect.promise(() => native.stat(NodePath.join(outside, "chapters"))),
        ).toBeTruthy();
      }).pipe(Effect.provide(TestLayer)),
  );
});
