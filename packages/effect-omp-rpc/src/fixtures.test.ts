// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

import { OmpRpcAvailableModels, OmpRpcEvent, OmpRpcReady, OmpRpcState } from "./schema.ts";

const fixtureDirectory = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../test/fixtures/v18.2.8", import.meta.url)),
);

const frames = (name: string): ReadonlyArray<unknown> =>
  NodeFS.readFileSync(NodePath.join(fixtureDirectory, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("OMP v18.2.8 recorded fixtures", () => {
  it("decodes the pinned startup and command frames", () => {
    const values = frames("startup.jsonl");
    expect(Schema.decodeUnknownSync(OmpRpcReady)(values[0])).toMatchObject({
      supportedProtocolVersions: [1, 2],
    });
    expect(Schema.decodeUnknownSync(OmpRpcEvent)(values[2])).toMatchObject({
      type: "available_commands_update",
    });
  });

  it("decodes real state and model capabilities", () => {
    const values = frames("state-and-models.jsonl");
    const state = Schema.decodeUnknownSync(OmpRpcState)((values[0] as { data: unknown }).data);
    expect(state.model).toMatchObject({ provider: "ollama", id: "qwen3.6:35b-a3b" });
    const models = Schema.decodeUnknownSync(OmpRpcAvailableModels)(
      (values[1] as { data: unknown }).data,
    );
    expect(models.models[0]?.input).toEqual(["text", "image"]);
  });

  it("preserves the real user message lifecycle for role-aware mapping", () => {
    const values = frames("prompt-events.jsonl");
    const messageStart = Schema.decodeUnknownSync(OmpRpcEvent)(values[3]);
    const messageEnd = Schema.decodeUnknownSync(OmpRpcEvent)(values[4]);
    expect(messageStart).toMatchObject({ type: "message_start" });
    expect(messageEnd).toMatchObject({ type: "message_end" });
    expect((messageStart.message as { role: string }).role).toBe("user");
    expect((messageEnd.message as { role: string }).role).toBe("user");
  });
});
