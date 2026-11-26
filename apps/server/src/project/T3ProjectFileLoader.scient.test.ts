import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const projectWith = Effect.fn("projectWith")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-project-file-" });
  for (const [name, contents] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(cwd, name), contents).pipe(Effect.orDie);
  }
  return cwd;
});

const ignored = (entries: ReadonlyArray<string>) => JSON.stringify({ ignoreRepositories: entries });

it.layer(layerTest)("T3ProjectFileLoader in Scient", (it) => {
  describe("load", () => {
    it.effect("reads scient.json, not the t3.json beside it", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* projectWith({
          "scient.json": ignored(["from-scient"]),
          "t3.json": ignored(["from-t3"]),
        });

        const loaded = yield* loader.load(cwd);

        expect(Option.getOrThrow(loaded).ignoreRepositories).toEqual(["from-scient"]);
      }),
    );

    it.effect("reads t3.json in a project with no scient.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* projectWith({ "t3.json": ignored(["from-t3"]) });

        const loaded = yield* loader.load(cwd);

        expect(Option.getOrThrow(loaded).ignoreRepositories).toEqual(["from-t3"]);
      }),
    );

    it.effect("keeps an invalid scient.json instead of falling back to t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* projectWith({
          "scient.json": "{ not json",
          "t3.json": ignored(["from-t3"]),
        });

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
