// @effect-diagnostics nodeBuiltinImport:off -- opt-in scale test uses a corpus outside the checkout.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../projectScope/WorkspaceBindingTestUtils.ts";
import * as DataTables from "./DataTables.ts";
import { DataViewPython } from "./DataViewRuntime.ts";
import * as DataViews from "./DataViews.ts";

const python = process.env.DATA_VIEW_TEST_PYTHON;
const corpus = process.env.DATA_VIEW_TEST_CORPUS;

describe.runIf(Boolean(python && corpus && process.env.DATA_VIEW_TEST_SCALE))(
  "DuckDB data view scale",
  () => {
    it.live("profiles all rows in the Places Parquet corpus", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "parquet-scale-" }),
        );
        const resolver = workspaceResolverForTest(
          new Map([
            [cwd, { projectId: "profile-test", scope: workspaceScopeForTest("profile-test", cwd) }],
          ]),
        );
        yield* Effect.gen(function* () {
          const views = yield* DataViews.DataViews;

          yield* Effect.promise(() =>
            NodeFSP.copyFile(
              paths.join(corpus!, "projects/data-scale/upstream/places.parquet"),
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
  },
);
