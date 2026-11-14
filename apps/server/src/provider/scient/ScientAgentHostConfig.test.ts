import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  hasImageGenerationAccount,
  scientAgentHostConfigText,
  writeScientAgentHostConfig,
} from "./ScientAgentHostConfig.ts";

it("turns computer control on with the full-access answer to foreground control, and lets goals continue", () => {
  assert.strictEqual(
    scientAgentHostConfigText({ computerControl: true, imageGeneration: true }),
    [
      "# Scient writes this file for the agent it runs and replaces it when settings change.",
      "computer:",
      "  enabled: true",
      "tools:",
      "  approval:",
      "    computer.control: allow",
      "generate_image:",
      "  enabled: true",
      "goal:",
      "  continuationModes: [interactive, rpc]",
      "",
    ].join("\n"),
  );
});

it("turns computer control off without granting anything", () => {
  const text = scientAgentHostConfigText({ computerControl: false, imageGeneration: false });
  assert.notInclude(text, "enabled: true");
  assert.notInclude(text, "computer.control");
});

it.effect("writes the overlay in place and replaces it when the setting changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeScientAgentHostConfig(root, {
      computerControl: true,
      imageGeneration: false,
    });
    assert.include(yield* fs.readFileString(file), "enabled: true");
    assert.strictEqual(
      yield* writeScientAgentHostConfig(root, {
        computerControl: false,
        imageGeneration: false,
      }),
      file,
    );
    assert.include(yield* fs.readFileString(file), "enabled: false");
    assert.deepEqual(yield* fs.readDirectory(root), ["scient-host.yml"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("turns image generation on only for a connected account that makes pictures", () => {
  const account = (id: string, connected = true) => ({
    id,
    name: id,
    kind: "account" as const,
    connected,
    canDisconnect: true,
  });
  assert.isTrue(hasImageGenerationAccount([account("anthropic"), account("openai-codex")]));
  assert.isTrue(hasImageGenerationAccount([account("google-antigravity")]));
  assert.isFalse(hasImageGenerationAccount([account("openai-codex", false)]));
  assert.isFalse(hasImageGenerationAccount([account("google-gemini-cli")]));
  assert.isFalse(hasImageGenerationAccount(undefined));
});
