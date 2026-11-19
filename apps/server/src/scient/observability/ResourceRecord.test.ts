import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import {
  ResourceRecord,
  layerWith,
  parseProcessUse,
  summarizeProcesses,
} from "./ResourceRecord.ts";

const MB_IN_KB = 1024;

describe("summarizeProcesses", () => {
  it("groups by executable name, Scient's descendants apart from the machine", () => {
    const table = parseProcessUse(
      [
        `  100     1 ${200 * MB_IN_KB} /Applications/Scient.app/Contents/MacOS/Scient Helper`,
        `  200   100 ${900 * MB_IN_KB} /Users/someone/.local/bin/claude`,
        `  201   200 ${300 * MB_IN_KB} /usr/bin/git`,
        `  202   200 ${100 * MB_IN_KB} /usr/bin/git`,
        `  300     1 ${4000 * MB_IN_KB} /usr/bin/git`,
        `  400     1 ${50 * MB_IN_KB} launchd`,
        "",
      ].join("\n"),
    );
    assert.deepStrictEqual(summarizeProcesses(table, 100), {
      scient: {
        count: 3,
        mb: 1300,
        largest: [
          { name: "claude", count: 1, mb: 900 },
          { name: "git", count: 2, mb: 400 },
        ],
      },
      machine: {
        count: 6,
        largest: [
          { name: "git", count: 3, mb: 4400 },
          { name: "claude", count: 1, mb: 900 },
          { name: "Scient Helper", count: 1, mb: 200 },
          { name: "launchd", count: 1, mb: 50 },
        ],
      },
    });
  });
});

describe("ResourceRecord", () => {
  it.effect("marks each start and keeps noted events as lines of names and numbers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "resource-record-" });
      const filePath = path.join(directory, "resource-record.ndjson");
      yield* Effect.gen(function* () {
        const record = yield* ResourceRecord;
        yield* record.note("checkpoint-upkeep", { durationMs: 1200, outcome: "done" });
      }).pipe(
        Effect.provide(
          layerWith(filePath).pipe(
            Layer.provide(
              Layer.succeed(HostResources.HostResources, {
                read: Effect.die("not sampled in this test"),
              }),
            ),
          ),
        ),
      );
      const lines = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepStrictEqual(
        lines.map(({ time: _time, ...fields }) => fields),
        [
          { event: "server-start" },
          { event: "checkpoint-upkeep", durationMs: 1200, outcome: "done" },
        ],
      );
      assert.match(String(lines[0]?.time), /^\d{4}-\d\d-\d\dT/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
