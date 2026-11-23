// @effect-diagnostics nodeBuiltinImport:off -- injects the host hard-link error before publication.
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DataFileTableError, DataViewError } from "@t3tools/contracts";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
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

const python = process.env.DATA_VIEW_TEST_PYTHON;
const corpus = process.env.DATA_VIEW_TEST_CORPUS;
const scale = process.env.DATA_VIEW_TEST_SCALE;

it.effect.skipIf(!python)("keeps the grid's raw-text matches in portable SQL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const cwd = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "data-view-search-" }),
    );
    yield* fs.writeFileString(
      paths.join(cwd, "dates.csv"),
      "id,visit\n1,11/23/2026\n2,11/24/2026\n3,01/02/2025\n",
    );
    yield* fs.writeFileString(paths.join(cwd, "decimal.csv"), "id;score\n1;0.70\n2;0.7\n3;0.80\n");
    // JS and DuckDB lowercase this character differently.
    yield* fs.writeFileString(paths.join(cwd, "case.csv"), "id,name\n1,İ\n2,z\n");
    const cases = [
      { path: "dates.csv", search: "11/2", expected: 2 },
      { path: "decimal.csv", search: "0.70", expected: 1 },
    ];
    if (corpus) {
      yield* fs.copyFile(
        paths.join(corpus, "projects/data-scale/housing_messy.csv"),
        paths.join(cwd, "housing.csv"),
      );
      yield* fs.copyFile(
        paths.join(corpus, "projects/threshold/data/predictions.csv"),
        paths.join(cwd, "threshold.csv"),
      );
      cases.push(
        { path: "housing.csv", search: "-999", expected: 292 },
        { path: "threshold.csv", search: "0.70", expected: 2 },
      );
    }
    const resolver = workspaceResolverForTest(
      new Map([[cwd, { projectId: "view-test", scope: workspaceScopeForTest("view-test", cwd) }]]),
    );
    const scenario = Effect.gen(function* () {
      const tables = yield* DataTables.DataTables;
      const views = yield* DataViews.DataViews;
      const allIds = (
        read: (
          offset: number,
        ) => Effect.Effect<
          { rows: ReadonlyArray<{ cells: ReadonlyArray<string | null> }>; matchCount: number },
          DataFileTableError | DataViewError
        >,
      ) =>
        Effect.gen(function* () {
          const result: Array<string | null> = [];
          let count: number;
          do {
            const { rows, matchCount } = yield* read(result.length);
            expect(rows.length > 0 || matchCount === 0).toBe(true);
            result.push(...rows.map((row) => row.cells[0] ?? null));
            count = matchCount;
          } while (result.length < count);
          return result;
        });
      for (const { path, search, expected } of cases) {
        const query = { search, sort: null, limit: 200 };
        const grid = yield* allIds((offset) =>
          tables.readFileTable({
            path: paths.join(cwd, path),
            sheet: 0,
            query: { ...query, offset },
          }),
        );
        const { path: saved } = yield* views.saveView({
          cwd,
          path,
          ...query,
          destination: `views/${path}.sql`,
          columns: [0],
        });
        const ids = yield* allIds((offset) =>
          views.readView({
            cwd,
            path: saved,
            query: { ...query, search: "", offset },
          }),
        );
        expect(ids, path).toEqual(grid);
        expect(ids, path).toHaveLength(expected);
      }
      const unverified = yield* views
        .saveView({
          cwd,
          path: "case.csv",
          search: "i̇",
          sort: null,
          destination: "views/case.sql",
          columns: [0],
        })
        .pipe(Effect.result);
      expect(unverified).toMatchObject({
        _tag: "Failure",
        failure: { reason: "search-not-saved" },
      });
      expect(yield* fs.exists(paths.join(cwd, "views/case.sql"))).toBe(false);
    });
    yield* scenario.pipe(
      Effect.provide(
        DataViews.layer.pipe(
          Layer.provideMerge(Layer.merge(DataTables.layer, LocalExecutionProcess.layer)),
        ),
      ),
      Effect.provideService(WorkspaceBindingResolver, resolver),
      Effect.provideService(DataViewPython, {
        executable: Effect.succeed(python!),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.skipIf(!python)("previews traced files and partitions and names unresolved reads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const cwd = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "data-view-refs-" }),
    );
    const write = (path: string, contents: string) =>
      fs.writeFileString(paths.join(cwd, path), contents);
    yield* fs.makeDirectory(paths.join(cwd, "data"));
    yield* fs.writeFile(paths.join(cwd, "data/zip.csv.gz"), NodeZlib.gzipSync("id\n5\n"));
    yield* write("data/opaque.dat", "id\n9\n");
    yield* write("zip.sql", 'SELECT * FROM "./data/zip.csv.gz"');
    yield* write("first.sql", "SELECT 1 AS id");
    yield* write("second.sql", "SELECT 2 AS id");
    yield* write("partitions.sql", 'SELECT * FROM "data/parts/*.parquet" ORDER BY id');
    yield* write("cte.sql", "WITH rows AS (SELECT 7 AS id) SELECT * FROM rows");
    yield* write("missing.sql", "SELECT * FROM 'data/nope.csv'");
    yield* write("missing-glob.sql", "SELECT * FROM 'data/nope-*.parquet'");
    yield* write("untraced.sql", "SELECT * FROM read_csv('data/opaque.dat')");
    yield* write("invalid.sql", "SELECT FROM");
    yield* write(
      "profile.sql",
      `SELECT * FROM (VALUES
        (NULL::DOUBLE, 'GreyWood…', repeat('x', 201)),
        ('NaN'::DOUBLE, 'NaN', repeat('💡', 110)),
        (3::DOUBLE, 'ordinary', 'short')
      ) AS source(number, literal, long)`,
    );
    const resolver = workspaceResolverForTest(
      new Map([[cwd, { projectId: "view-test", scope: workspaceScopeForTest("view-test", cwd) }]]),
    );
    const scenario = Effect.gen(function* () {
      const views = yield* DataViews.DataViews;
      const rows = (path: string) =>
        views.readView({
          cwd,
          path,
          query: { search: "", sort: null, offset: 0, limit: 10 },
        });
      {
        using unsupported = vi
          .spyOn(NodeFSP, "link")
          .mockRejectedValueOnce(Object.assign(new Error("No hard links"), { code: "ENOTSUP" }));
        yield* views.materializeView({
          cwd,
          path: "first.sql",
          destination: "data/parts/first.parquet",
        });
        expect(unsupported).toHaveBeenCalledTimes(1);
      }
      yield* views.materializeView({
        cwd,
        path: "second.sql",
        destination: "data/parts/second.parquet",
      });
      for (const [path, ids] of [
        ["zip.sql", ["5"]],
        ["partitions.sql", ["1", "2"]],
        ["cte.sql", ["7"]],
      ] as const) {
        const page = yield* rows(path);
        expect(
          page.rows.map((row) => row.cells[0]),
          path,
        ).toEqual(ids);
      }
      const profile = yield* views.profileView({ cwd, path: "profile.sql" });
      expect(profile.columns).toMatchObject([
        { missing: 1, nanCount: 1, distinct: 2, range: { min: "3.0", max: "3.0" } },
        { missing: 0, distinct: 3, distinctLowerBound: false, valuesClipped: false },
        { missing: 0, distinct: 3, distinctLowerBound: true, valuesClipped: true },
      ]);
      expect(profile.columns[1]).not.toHaveProperty("nanCount");
      for (const [path, reason, reference] of [
        ["missing.sql", "source-missing", "data/nope.csv"],
        ["missing-glob.sql", "source-missing", "data/nope-*.parquet"],
        ["untraced.sql", "source-untraced", "data/opaque.dat"],
        ["invalid.sql", "query-failed"],
      ] as const) {
        const result = yield* rows(path).pipe(Effect.result);
        expect(result, path).toMatchObject({
          _tag: "Failure",
          failure: { reason, ...(reference ? { reference } : {}) },
        });
      }
    });
    yield* scenario.pipe(
      Effect.provide(
        DataViews.layer.pipe(
          Layer.provideMerge(Layer.merge(DataTables.layer, LocalExecutionProcess.layer)),
        ),
      ),
      Effect.provideService(WorkspaceBindingResolver, resolver),
      Effect.provideService(DataViewPython, { executable: Effect.succeed(python!) }),
    );
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

it.effect.skipIf(!python)(
  "profiles Parquet categories beyond the sample and keeps footer accuracy",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const cwd = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "parquet-profile-" }),
      );
      yield* fs.writeFileString(
        paths.join(cwd, "create.sql"),
        `
      SELECT i / 3000.0 AS score,
        CASE WHEN i < 2500 THEN 'open'
          WHEN i < 2990 THEN 'closed' ELSE 'temporary' END AS status
      FROM range(3000) AS r(i)
    `,
      );
      const resolver = workspaceResolverForTest(
        new Map([
          [cwd, { projectId: "profile-test", scope: workspaceScopeForTest("profile-test", cwd) }],
        ]),
      );
      yield* Effect.gen(function* () {
        const views = yield* DataViews.DataViews;
        yield* views.materializeView({ cwd, path: "create.sql", destination: "profile.parquet" });
        const full = yield* views.profileDataset({ cwd, path: "profile.parquet" });
        expect(full).toMatchObject({ scope: "all", rowCount: 3000, rowsProfiled: 3000 });
        expect(full.columns[0]).toMatchObject({
          missing: 0,
          missingFromFooter: true,
          range: { min: "0", max: String(2999 / 3000) },
          rangeFromFooter: true,
        });
        expect(full.columns[1]).toMatchObject({
          distinct: 3,
          top: [
            { value: "open", count: 2500 },
            { value: "closed", count: 490 },
            { value: "temporary", count: 10 },
          ],
        });

        const sample = yield* views
          .profileFile({
            path: paths.join(cwd, "profile.parquet"),
            sheet: 0,
            sampleOnly: true,
          })
          .pipe(Stream.runLast);
        expect(Option.getOrUndefined(sample)).toMatchObject({
          _tag: "Complete",
          profile: {
            scope: "sample",
            rowsProfiled: 2048,
            columns: [{ rangeFromFooter: true }, { top: [{ value: "open", count: 2048 }] }],
          },
        });

        if (corpus && scale) {
          yield* Effect.promise(() =>
            NodeFSP.copyFile(
              paths.join(corpus, "projects/data-scale/upstream/places.parquet"),
              paths.join(cwd, "places.parquet"),
              NodeFSP.constants.COPYFILE_FICLONE,
            ),
          );
          const places = yield* views.profileDataset({ cwd, path: "places.parquet" });
          expect(places).toMatchObject({
            scope: "all",
            rowsProfiled: 5_668_486,
            rowCount: 5_668_486,
          });
          expect(places.columns.find(({ column }) => column.name === "confidence")).toMatchObject({
            missing: 0,
            missingFromFooter: true,
            distinctApproximate: true,
            range: { min: "0.010859756730496883", max: "1" },
            rangeFromFooter: true,
          });
          expect(
            places.columns.find(({ column }) => column.name === "operating_status"),
          ).toMatchObject({
            missing: 1_782_664,
            distinct: 3,
            distinctApproximate: false,
            top: [
              { value: "open", count: 3_772_446 },
              { value: "permanently_closed", count: 113_315 },
              { value: "temporarily_closed", count: 61 },
            ],
          });
        }
      }).pipe(
        Effect.provide(
          DataViews.layer.pipe(
            Layer.provideMerge(Layer.merge(DataTables.layer, LocalExecutionProcess.layer)),
          ),
        ),
        Effect.provideService(WorkspaceBindingResolver, resolver),
        Effect.provideService(DataViewPython, { executable: Effect.succeed(python!) }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
