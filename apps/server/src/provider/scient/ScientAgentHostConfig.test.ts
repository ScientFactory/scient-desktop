import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { scientAgentHostConfigText, writeScientAgentHostConfig } from "./ScientAgentHostConfig.ts";

it("turns computer control on with the full-access answer to foreground control", () => {
  assert.strictEqual(
    scientAgentHostConfigText({ computerControl: true }),
    [
      "# Scient writes this file for the agent it runs and replaces it when settings change.",
      "computer:",
      "  enabled: true",
      "tools:",
      "  approval:",
      "    computer.control: allow",
      "",
    ].join("\n"),
  );
});

it("turns computer control off without granting anything", () => {
  const text = scientAgentHostConfigText({ computerControl: false });
  assert.include(text, "  enabled: false");
  assert.notInclude(text, "computer.control");
});

it.effect("writes the overlay in place and replaces it when the setting changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeScientAgentHostConfig(root, { computerControl: true });
    assert.include(yield* fs.readFileString(file), "enabled: true");
    assert.strictEqual(yield* writeScientAgentHostConfig(root, { computerControl: false }), file);
    assert.include(yield* fs.readFileString(file), "enabled: false");
    assert.deepEqual(yield* fs.readDirectory(root), ["scient-host.yml"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
