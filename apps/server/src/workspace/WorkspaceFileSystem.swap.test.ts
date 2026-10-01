// @effect-diagnostics nodeBuiltinImport:off - the test swaps a file at the instant it is opened.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
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
const TestLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(entriesStub),
  Layer.provideMerge(NodeServices.layer),
);

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(NodeFSP.open).mockImplementation(native.open);
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
          .readFile({ cwd: workspace, relativePath: "notes.md" })
          .pipe(Effect.result);

        expect(armed).toBe(false);
        // It must not return the outside file as an editable workspace file.
        expect(swapped._tag).toBe("Failure");
        // Read again, the link is resolved properly: its target, read-only.
        const reread = yield* workspaceFileSystem.readFile({
          cwd: workspace,
          relativePath: "notes.md",
        });
        expect(reread).toMatchObject({ contents: "outside\n", readOnly: true });
      }).pipe(Effect.provide(TestLayer)),
  );
});
