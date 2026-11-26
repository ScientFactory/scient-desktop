import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadDefinitions } from "./WorkflowRuntime.ts";

const fileDefining = (api: "Scient" | "T3", name: string) => `const { workflow } = ${api};
workflow(${JSON.stringify(name)}, { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.succeed("done"),
);
`;

it.effect("a workflow file reads its API as Scient, and as T3 from before the rename", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-workflow-" });
    const scientFile = path.join(directory, "scient-named.ts");
    const t3File = path.join(directory, "t3-named.ts");
    yield* fileSystem.writeFileString(scientFile, fileDefining("Scient", "scient-named"));
    yield* fileSystem.writeFileString(t3File, fileDefining("T3", "t3-named"));

    const scient = yield* loadDefinitions(scientFile);
    const t3 = yield* loadDefinitions(t3File);

    assert.deepStrictEqual(
      [...scient, ...t3].map((definition) => definition.name),
      ["scient-named", "t3-named"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
