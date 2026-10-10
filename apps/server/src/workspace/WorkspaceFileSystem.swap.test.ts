// @effect-diagnostics nodeBuiltinImport:off - the test swaps a file at the instant it is opened.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  return { ...actual, open: vi.fn(actual.open) };
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
  for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true });
});

describe("WorkspaceFileSystem.readFile", () => {
  // Windows has neither symlink-on-open semantics nor O_NOFOLLOW.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
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
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
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
