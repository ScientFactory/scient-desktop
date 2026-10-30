import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ComputeExecutionId, ComputeSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as NotebookStore from "./NotebookStore.ts";

const notebook = {
  cells: [
    { cell_type: "markdown", id: "title", metadata: {}, source: ["# Title"] },
    {
      cell_type: "code",
      execution_count: 1,
      id: "first",
      metadata: { tags: ["keep"] },
      outputs: [{ name: "stdout", output_type: "stream", text: ["one\n"] }],
      source: ["a = 1"],
    },
    {
      cell_type: "code",
      execution_count: null,
      id: "second",
      metadata: {},
      outputs: [],
      source: [],
    },
  ],
  metadata: { language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
};

const path = "study.ipynb";

const files = Layer.effect(
  WorkspaceFileSystem.WorkspaceFileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      writeBinaryFile: (input: { cwd: string; relativePath: string; bytes: Uint8Array }) =>
        fs.writeFile(`${input.cwd}/${input.relativePath}`, input.bytes).pipe(Effect.orDie),
    } as never;
  }),
);
const paths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  resolveRelativePathWithinRoot: (input: { workspaceRoot: string; relativePath: string }) =>
    Effect.succeed({
      absolutePath: `${input.workspaceRoot}/${input.relativePath}`,
      relativePath: input.relativePath,
    }),
} as never);

/** A store over a real notebook file in a temporary project. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-notebook-" });
  yield* fs.writeFileString(`${cwd}/${path}`, JSON.stringify(notebook, null, 1));
  const store = yield* NotebookStore.makeNotebookStore;
  const onDisk = Effect.map(
    fs.readFileString(`${cwd}/${path}`),
    (text) => JSON.parse(text) as typeof notebook,
  );
  const writeOutside = (text: string) => fs.writeFileString(`${cwd}/${path}`, text);
  return { cwd, store, onDisk, writeOutside };
});

const run = { execution: "run-1", code: "hash", at: "2026-10-30T10:00:00.000Z", ms: 12 };
const record = {
  path,
  cellId: "second",
  sessionId: ComputeSessionId.make("session"),
  executionId: ComputeExecutionId.make("run-1"),
  executionCount: null,
  run,
};

describe("NotebookStore", () => {
  const testLayer = Layer.mergeAll(
    Layer.provide(files, NodeServices.layer),
    paths,
    NodeServices.layer,
  );
  const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(testLayer), Effect.scoped) as Effect.Effect<A, E, never>;

  it.effect("reads cells and reports when nothing changed", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store } = yield* fixture;
        const view = yield* store.read({ cwd, path });
        expect(view?.cells.map((cell) => cell.id)).toEqual(["title", "first", "second"]);
        expect(view?.cells[1]?.source).toBe("a = 1");
        expect(JSON.parse(view?.cells[1]?.outputs[0]?.json ?? "{}").output_type).toBe("stream");
        expect(yield* store.read({ cwd, path, knownRevision: view?.revision ?? "" })).toBeNull();
      }),
    ),
  );

  it.effect("saves edits to the file and keeps other cells as they were", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        yield* store.edit({
          cwd,
          path,
          edits: [
            { _tag: "set-source", cellId: "second", source: "b = 2\nc = 3" },
            { _tag: "move", cellId: "second", offset: -1 },
            { _tag: "insert", cellId: "new", afterCellId: null, cellType: "code", source: "x" },
          ],
        });
        yield* store.flush({ cwd, path });
        const saved = yield* onDisk;
        expect(saved.cells.map((cell) => cell.id)).toEqual(["new", "title", "second", "first"]);
        expect(saved.cells[2]?.source).toEqual(["b = 2\n", "c = 3"]);
        expect(saved.cells[3]).toEqual(notebook.cells[1]);
      }),
    ),
  );

  it.effect("restores a deleted cell with its outputs", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        yield* store.edit({ cwd, path, edits: [{ _tag: "delete", cellId: "first" }] });
        yield* store.edit({
          cwd,
          path,
          edits: [{ _tag: "restore", cellId: "first", afterCellId: "title" }],
        });
        yield* store.flush({ cwd, path });
        expect((yield* onDisk).cells[1]).toEqual(notebook.cells[1]);
      }),
    ),
  );

  it.effect("clears outputs and converts cells", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        yield* store.edit({
          cwd,
          path,
          edits: [
            { _tag: "clear-outputs" },
            { _tag: "convert", cellId: "second", cellType: "markdown" },
          ],
        });
        yield* store.flush({ cwd, path });
        const saved = yield* onDisk;
        expect(saved.cells[1]?.outputs).toEqual([]);
        expect(saved.cells[1]?.execution_count).toBeNull();
        expect(saved.cells[2]?.cell_type).toBe("markdown");
        expect(saved.cells[2]?.outputs).toBeUndefined();
      }),
    ),
  );

  it.effect("adopts an outside edit and keeps edits not yet written", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk, writeOutside } = yield* fixture;
        yield* store.read({ cwd, path });
        yield* store.edit({
          cwd,
          path,
          edits: [{ _tag: "set-source", cellId: "second", source: "mine" }],
        });
        const outside = structuredClone(notebook);
        outside.cells[0]!.source = ["# Changed outside"];
        yield* writeOutside(`${JSON.stringify(outside, null, 1)}\n`);
        const view = yield* store.read({ cwd, path });
        expect(view?.cells[0]?.source).toBe("# Changed outside");
        expect(view?.cells[2]?.source).toBe("mine");
        yield* store.flush({ cwd, path });
        const saved = yield* onDisk;
        expect(saved.cells[0]?.source).toEqual(["# Changed outside"]);
        expect(saved.cells[2]?.source).toEqual(["mine"]);
      }),
    ),
  );

  it.effect("records a run once, keeping the kernel's count", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        let reads = 0;
        const first = yield* store.recordRun({ ...record, cwd, executionCount: 7 }, () =>
          Effect.sync(() => {
            reads += 1;
            return {
              outputs: [{ output_type: "stream", name: "stdout", text: "two\n" }],
              executionCount: null,
            };
          }),
        );
        expect(first.cell?.executionCount).toBe(7);
        expect(first.cell?.run?.ms).toBe(12);
        const again = yield* store.recordRun({ ...record, cwd }, () => Effect.die("read twice"));
        expect(again.cell?.executionCount).toBe(7);
        expect(reads).toBe(1);
        yield* store.flush({ cwd, path });
        const saved = (yield* onDisk).cells[2] as unknown as Record<string, unknown>;
        expect(saved.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "two\n" }]);
        expect(saved.metadata).toEqual({ scient: run });
      }),
    ),
  );

  it.effect("gives two windows opening at once the same notebook", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        yield* Effect.all(
          [
            store.edit({
              cwd,
              path,
              edits: [{ _tag: "set-source", cellId: "first", source: "from one" }],
            }),
            store.edit({
              cwd,
              path,
              edits: [{ _tag: "set-source", cellId: "second", source: "from two" }],
            }),
          ],
          { concurrency: "unbounded" },
        );
        yield* store.flush({ cwd, path });
        const saved = yield* onDisk;
        expect(saved.cells[1]?.source).toEqual(["from one"]);
        expect(saved.cells[2]?.source).toEqual(["from two"]);
      }),
    ),
  );

  it.effect("keeps a recorded result when the file changes before it is saved", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk, writeOutside } = yield* fixture;
        yield* store.recordRun({ ...record, cwd }, () =>
          Effect.succeed({
            outputs: [{ output_type: "stream", name: "stdout", text: "kept\n" }],
            executionCount: null,
          }),
        );
        const outside = structuredClone(notebook);
        outside.cells[0]!.source = ["# Changed outside"];
        yield* writeOutside(`${JSON.stringify(outside, null, 1)}\n`);
        yield* store.flush({ cwd, path });
        const saved = (yield* onDisk).cells as unknown as ReadonlyArray<Record<string, unknown>>;
        expect(saved[0]?.source).toEqual(["# Changed outside"]);
        expect(saved[2]?.outputs).toEqual([
          { output_type: "stream", name: "stdout", text: "kept\n" },
        ]);
      }),
    ),
  );

  it.effect("an older result leaves a newer run still expected", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store } = yield* fixture;
        yield* store.edit({
          cwd,
          path,
          edits: [{ _tag: "expect-run", cellId: "second", execution: "run-2" }],
        });
        const recorded = yield* store.recordRun({ ...record, cwd }, () =>
          Effect.succeed({ outputs: [], executionCount: null }),
        );
        expect(recorded.cell?.pendingExecution).toBe("run-2");
      }),
    ),
  );

  it.effect("undo still works after other notebooks pushed this one out", () =>
    scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, store, onDisk } = yield* fixture;
        yield* store.edit({ cwd, path, edits: [{ _tag: "delete", cellId: "first" }] });
        yield* store.flush({ cwd, path });
        for (const other of ["a", "b", "c", "d", "e"]) {
          yield* fs.writeFileString(`${cwd}/${other}.ipynb`, JSON.stringify(notebook));
          yield* store.read({ cwd, path: `${other}.ipynb` });
        }
        yield* store.edit({
          cwd,
          path,
          edits: [{ _tag: "restore", cellId: "first", afterCellId: "title" }],
        });
        yield* store.flush({ cwd, path });
        expect((yield* onDisk).cells[1]).toEqual(notebook.cells[1]);
      }),
    ),
  );

  it.effect("keeps a pending run in the file until its result is recorded", () =>
    scoped(
      Effect.gen(function* () {
        const { cwd, store, onDisk } = yield* fixture;
        yield* store.edit({
          cwd,
          path,
          edits: [{ _tag: "expect-run", cellId: "second", execution: "run-9" }],
        });
        expect((yield* store.read({ cwd, path }))?.cells[2]?.pendingExecution).toBe("run-9");
        yield* store.flush({ cwd, path });
        const saved = (yield* onDisk).cells[2] as unknown as Record<string, unknown>;
        expect(saved.metadata).toEqual({ scient: { pending: "run-9" } });
      }),
    ),
  );
});
