// @effect-diagnostics nodeBuiltinImport:off -- injects the host hard-link error before publication.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../projectScope/WorkspaceBindingTestUtils.ts";
import * as DataTables from "./DataTables.ts";
import { DataViewPython, makeDataViewRuntime } from "./DataViewRuntime.ts";
import * as DataViews from "./DataViews.ts";

vi.mock("node:fs/promises", { spy: true });

it.effect.each(["hard link", "exclusive copy"] as const)(
  "publishes one complete SQL file via %s when concurrent saves choose the same name",
  (mode) =>
    Effect.gen(function* () {
      using unsupported =
        mode === "exclusive copy"
          ? vi
              .spyOn(NodeFSP, "link")
              .mockRejectedValue(Object.assign(new Error("No hard links"), { code: "ENOTSUP" }))
          : undefined;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "data-view-" });
      const cwd = yield* fs.realPath(folder);
      const path = "city's.csv";
      const source = paths.join(cwd, path);
      const data = "id,score\n1,0.7\n2,0.3\n";
      yield* fs.writeFileString(source, data);
      const resolver = workspaceResolverForTest(
        new Map([
          [cwd, { projectId: "view-test", scope: workspaceScopeForTest("view-test", cwd) }],
        ]),
      );
      const destination = "recheck/nested/shortlist.sql";
      const input = { cwd, path, destination, search: "", sort: null };
      const results = yield* Effect.gen(function* () {
        const views = yield* DataViews.DataViews;
        return yield* Effect.forEach(
          [[0], [1]],
          (columns) => views.saveView({ ...input, columns }).pipe(Effect.result),
          { concurrency: 2 },
        );
      }).pipe(
        Effect.provide(
          DataViews.layer.pipe(
            Layer.provideMerge(Layer.merge(DataTables.layer, Layer.mock(ExecutionProcess)({}))),
          ),
        ),
        Effect.provideService(WorkspaceBindingResolver, resolver),
        Effect.provideService(DataViewPython, {
          executable: Effect.die("no runtime needed to save SQL"),
        }),
      );
      if (unsupported) expect(unsupported).toHaveBeenCalled();
      expect(results.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
      expect(results.find(({ _tag }) => _tag === "Failure")).toMatchObject({
        failure: { reason: "destination-exists" },
      });
      const sql = yield* fs.readFileString(paths.join(cwd, destination));
      expect(sql).toMatch(/^SELECT "(id|score)"\nFROM 'city''s\.csv';\n$/u);
      expect(yield* fs.readFileString(source)).toBe(data);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports a view timeout and cancels the owned DuckDB process", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const run = yield* makeDataViewRuntime.pipe(
      Effect.provideService(ExecutionProcess, {
        start: () =>
          Effect.succeed({
            output: Stream.empty,
            exitCode: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
            cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
          }),
      }),
    );
    const reading = yield* Effect.forkChild(
      run(".", {
        sql: "SELECT 1",
        sources: [],
        query: { search: "", sort: null, offset: 0, limit: 1 },
      }).pipe(Effect.result),
    );
    yield* Deferred.await(waiting);
    yield* TestClock.adjust("45 seconds");
    expect(yield* Fiber.join(reading)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "query-timeout" },
    });
    expect(yield* Deferred.isDone(cancelled)).toBe(true);
  }).pipe(
    Effect.scoped,
    Effect.provideService(DataViewPython, { executable: Effect.succeed("unused") }),
    Effect.provide(NodeServices.layer),
  ),
);
