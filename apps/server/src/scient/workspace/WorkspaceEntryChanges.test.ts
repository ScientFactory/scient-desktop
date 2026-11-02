// @effect-diagnostics nodeBuiltinImport:off - the fixture builds folders, links and Git files directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { WorkspaceEntryChange } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { changeWorkspaceEntries } from "./WorkspaceEntryChanges.ts";

const layer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.promise(async () =>
        ServerConfig.layerTest(
          process.cwd(),
          await NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-entry-state-")),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** A project and a home folder whose freedesktop Trash stands in for the computer's. */
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-entry-changes-")),
    );
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    const write = async (relativePath: string, contents = relativePath) => {
      const target = NodePath.join(project, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, contents);
    };
    const read = (relativePath: string) =>
      NodeFSP.readFile(NodePath.join(project, relativePath), "utf8").catch(() => null);
    return { base, project, home: NodePath.join(base, "home"), write, read };
  }),
  ({ base }) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
);

const change = (project: string, home: string, request: WorkspaceEntryChange) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return yield* changeWorkspaceEntries(workspace.resolveEntryPath, {
      cwd: project,
      change: request,
    });
  }).pipe(
    // Every platform runs the freedesktop Trash in a temporary home, never the real Trash.
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.UserId, 501),
  );

it.layer(layer, { excludeTestServices: true })("changeWorkspaceEntries", (it) => {
  describe("move and copy", () => {
    it.effect("moves files and folders, picks free names, and never puts a folder in itself", () =>
      Effect.gen(function* () {
        const { project, home, write, read } = yield* fixture;
        yield* Effect.promise(async () => {
          await write("notes.md", "mine");
          await write("data/run.csv");
          await write("archive/notes.md", "theirs");
        });

        const clash = yield* change(project, home, {
          _tag: "move",
          items: [{ from: "notes.md", to: "archive/notes.md" }],
          collision: "ask",
        }).pipe(Effect.flip);
        expect(clash).toMatchObject({ failure: "exists", paths: ["archive/notes.md"] });

        const moved = yield* change(project, home, {
          _tag: "move",
          items: [
            { from: "notes.md", to: "archive/notes.md" },
            { from: "data", to: "archive/data" },
          ],
          collision: "keep-both",
        });
        expect(moved.entries).toEqual([
          { from: "notes.md", to: "archive/notes 2.md" },
          { from: "data", to: "archive/data" },
        ]);
        expect(yield* Effect.promise(() => read("archive/notes 2.md"))).toBe("mine");
        expect(yield* Effect.promise(() => read("archive/data/run.csv"))).toBe("data/run.csv");

        const duplicated = yield* change(project, home, {
          _tag: "copy",
          items: [{ from: "archive/data", to: "archive/data" }],
          collision: "keep-both",
        });
        expect(duplicated.entries).toEqual([{ from: "archive/data", to: "archive/data copy" }]);
        expect(yield* Effect.promise(() => read("archive/data copy/run.csv"))).toBe("data/run.csv");

        const intoItself = yield* change(project, home, {
          _tag: "move",
          items: [{ from: "archive", to: "archive/data/archive" }],
          collision: "ask",
        }).pipe(Effect.flip);
        expect(intoItself.failure).toBe("into-itself");
      }),
    );
  });

  describe("import", () => {
    it.effect("copies files and folders in from elsewhere, never the project into itself", () =>
      Effect.gen(function* () {
        const { base, project, home, write, read } = yield* fixture;
        yield* Effect.promise(async () => {
          await write("inbox/keep.md");
          await NodeFSP.mkdir(NodePath.join(base, "downloads", "scans"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(base, "downloads", "scans", "page.txt"), "page");
          await NodeFSP.writeFile(NodePath.join(base, "downloads", "table.csv"), "a,b");
        });

        const imported = yield* change(project, home, {
          _tag: "import",
          sources: [
            NodePath.join(base, "downloads", "scans"),
            NodePath.join(base, "downloads", "table.csv"),
          ],
          folder: "inbox",
          collision: "ask",
        });
        expect(imported.entries.map((entry) => entry.to)).toEqual([
          "inbox/scans",
          "inbox/table.csv",
        ]);
        expect(yield* Effect.promise(() => read("inbox/scans/page.txt"))).toBe("page");
        // The originals stay where they were.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(base, "downloads", "table.csv"), "utf8"),
          ),
        ).toBe("a,b");

        const intoItself = yield* change(project, home, {
          _tag: "import",
          sources: [base],
          folder: "inbox",
          collision: "ask",
        }).pipe(Effect.flip);
        expect(intoItself.failure).toBe("into-itself");
        const relative = yield* change(project, home, {
          _tag: "import",
          sources: ["downloads/table.csv"],
          folder: "",
          collision: "ask",
        }).pipe(Effect.flip);
        expect(relative.failure).toBe("not-allowed");
      }),
    );
  });

  describe("the Trash", () => {
    it.effect("moves items to the Trash, replaces through it, and puts them back", () =>
      Effect.gen(function* () {
        const { project, home, write, read } = yield* fixture;
        yield* Effect.promise(async () => {
          await write("draft.md", "draft");
          await write("figures/plot.png", "plot");
          await write("figures/old/plot.png", "old plot");
        });

        const trashed = yield* change(project, home, {
          _tag: "trash",
          // A file inside a listed folder goes with the folder.
          relativePaths: ["draft.md", "figures/old", "figures/old/plot.png"],
        });
        expect(trashed.entries.map((entry) => entry.from)).toEqual(["draft.md", "figures/old"]);
        expect(yield* Effect.promise(() => read("draft.md"))).toBeNull();
        const trashFiles = NodePath.join(home, ".local", "share", "Trash", "files");
        expect((yield* Effect.promise(() => NodeFSP.readdir(trashFiles))).toSorted()).toEqual([
          "draft.md",
          "old",
        ]);

        const replaced = yield* change(project, home, {
          _tag: "move",
          items: [{ from: "figures/plot.png", to: "plot.png" }],
          collision: "ask",
        });
        expect(replaced.entries).toEqual([{ from: "figures/plot.png", to: "plot.png" }]);
        yield* Effect.promise(() => write("figures/plot.png", "new plot"));
        const replacing = yield* change(project, home, {
          _tag: "move",
          items: [{ from: "figures/plot.png", to: "plot.png" }],
          collision: "replace",
        });
        expect(replacing.entries[0]).toMatchObject({ from: "plot.png" });
        expect(yield* Effect.promise(() => read("plot.png"))).toBe("new plot");

        const restored = yield* change(project, home, {
          _tag: "restore",
          restoreIds: [
            ...trashed.entries.map((entry) => entry.restoreId!),
            replacing.entries[0]!.restoreId!,
          ],
        });
        expect(restored.entries.map((entry) => entry.to)).toEqual([
          "draft.md",
          "figures/old",
          "plot 2.png",
        ]);
        expect(yield* Effect.promise(() => read("draft.md"))).toBe("draft");
        expect(yield* Effect.promise(() => read("figures/old/plot.png"))).toBe("old plot");
        expect(yield* Effect.promise(() => read("plot 2.png"))).toBe("plot");
        const trashInfo = NodePath.join(home, ".local", "share", "Trash", "info");
        expect(yield* Effect.promise(() => NodeFSP.readdir(trashInfo))).toEqual([]);

        const again = yield* change(project, home, {
          _tag: "restore",
          restoreIds: [trashed.entries[0]!.restoreId!],
        }).pipe(Effect.flip);
        expect(again.failure).toBe("restore-unavailable");
      }),
    );
  });

  describe("limits", () => {
    it.effect("names a new folder freely and refuses what Files only shows", () =>
      Effect.gen(function* () {
        const { project, home, write } = yield* fixture;
        yield* Effect.promise(async () => {
          await write(".scient/project.json", "{}");
          await write("untitled folder/keep.md");
          await NodeFSP.mkdir(NodePath.join(project, ".git"));
        });

        const created = yield* change(project, home, {
          _tag: "create-folder",
          relativePath: "untitled folder",
        });
        expect(created.entries).toEqual([{ to: "untitled folder 2" }]);
        const file = yield* change(project, home, {
          _tag: "create-file",
          relativePath: "untitled.md",
        });
        expect(file.entries).toEqual([{ to: "untitled.md" }]);

        for (const relativePath of [".scient/project.json", ".git", "..", ""]) {
          const refused = yield* change(project, home, {
            _tag: "trash",
            relativePaths: [relativePath],
          }).pipe(Effect.flip);
          expect(refused.failure, relativePath).toBe("not-allowed");
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)("refuses a path through a linked folder", () =>
      Effect.gen(function* () {
        const { base, project, home, write } = yield* fixture;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(base, "outside"));
          await NodeFSP.writeFile(NodePath.join(base, "outside", "secret.txt"), "secret");
          await NodeFSP.symlink(NodePath.join(base, "outside"), NodePath.join(project, "linked"));
          await write("notes.md");
        });

        const refused = yield* change(project, home, {
          _tag: "move",
          items: [{ from: "notes.md", to: "linked/notes.md" }],
          collision: "ask",
        }).pipe(Effect.flip);
        expect(refused.failure).toBe("not-allowed");
        const trashedLink = yield* change(project, home, {
          _tag: "trash",
          relativePaths: ["linked/secret.txt"],
        }).pipe(Effect.flip);
        expect(trashedLink.failure).toBe("not-allowed");
      }),
    );
  });
});
