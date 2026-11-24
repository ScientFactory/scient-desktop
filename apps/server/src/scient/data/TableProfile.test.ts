import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { DataTables, layer } from "./DataTables.ts";

it.effect(
  "counts missing and distinct values over the rows it reports, including empty fields",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "table-profile-" });
      const path = paths.join(folder, "data.csv");
      yield* fs.writeFileString(
        path,
        "id,group\n9007199254740993,yes\n9007199254740992,\n9007199254740994,yes\n",
      );
      const tables = yield* DataTables;
      const events = yield* tables.profileFile({ path, sheet: 0 }).pipe(Stream.runCollect);
      expect(events[0]).toMatchObject({ _tag: "Progress", rowCount: null });
      expect(events.at(-1)).toMatchObject({
        _tag: "Complete",
        profile: {
          scope: "all",
          rowsProfiled: 3,
          rowCount: 3,
          columns: [
            {
              missing: 0,
              distinct: 3,
              range: { min: "9007199254740992", max: "9007199254740994" },
            },
            { missing: 1, missingShare: 1 / 3, distinct: 1, top: [{ value: "yes", count: 2 }] },
          ],
        },
      });
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
);

it.effect("keeps full-file ranges when distinct values exceed the memory cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "table-profile-" });
    const path = paths.join(folder, "data.csv");
    const rows = Array.from({ length: 20_000 }, (_, i) => `${i},${i === 19999 ? "" : "value"}`);
    yield* fs.writeFileString(path, `id,group\n${rows.join("\n")}\n`);
    const tables = yield* DataTables;
    const events = yield* tables.profileFile({ path, sheet: 0 }).pipe(Stream.runCollect);
    expect(events.at(-1)).toMatchObject({
      _tag: "Complete",
      profile: {
        scope: "all",
        rowsProfiled: 20_000,
        columns: [
          { distinctLowerBound: true, range: { min: "0", max: "19999" } },
          { distinct: 1, distinctLowerBound: false, missing: 1 },
        ],
      },
    });
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
);
