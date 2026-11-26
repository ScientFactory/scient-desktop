import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readProjectFileText } from "./scientProjectFile.ts";

describe("readProjectFileText", () => {
  it.effect(
    "falls back to t3.json only when scient.json is missing, not when it fails to read",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const missing = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-" });
        yield* fileSystem.writeFileString(path.join(missing, "t3.json"), "{}");
        const unreadable = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-" });
        yield* fileSystem.writeFileString(path.join(unreadable, "t3.json"), "{}");
        // A folder in its place reads as an error other than not found, on every platform.
        yield* fileSystem.makeDirectory(path.join(unreadable, "scient.json"));

        expect(yield* readProjectFileText(missing)).toBe("{}");
        expect(yield* readProjectFileText(unreadable)).toBeNull();
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
