// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

import {
  OmpAgentEndEvent,
  OmpMessageEndEvent,
  OmpMessageStartEvent,
  OmpMessageUpdateEvent,
  OmpRpcAvailableModels,
  OmpRpcEvent,
  OmpRpcReady,
  OmpRpcState,
  OmpSubagentFrame,
} from "./schema.ts";

const decodeReady = Schema.decodeUnknownSync(OmpRpcReady);
const decodeEvent = Schema.decodeUnknownSync(OmpRpcEvent);
const decodeState = Schema.decodeUnknownSync(OmpRpcState);
const decodeModels = Schema.decodeUnknownSync(OmpRpcAvailableModels);
const decodeSubagent = Schema.decodeSync(OmpSubagentFrame);
const decodeMessageStart = Schema.decodeUnknownSync(OmpMessageStartEvent);
const decodeMessageUpdate = Schema.decodeUnknownSync(OmpMessageUpdateEvent);
const decodeMessageEnd = Schema.decodeUnknownSync(OmpMessageEndEvent);
const decodeAgentEnd = Schema.decodeUnknownSync(OmpAgentEndEvent);

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
    expect(decodeReady(values[0])).toMatchObject({
      supportedProtocolVersions: [1, 2],
    });
    expect(decodeEvent(values[2])).toMatchObject({
      type: "available_commands_update",
    });
  });

  it("decodes real state and model capabilities", () => {
    const values = frames("state-and-models.jsonl");
    const state = decodeState((values[0] as { data: unknown }).data);
    expect(state.model).toMatchObject({ provider: "ollama", id: "qwen3.6:35b-a3b" });
    const models = decodeModels((values[1] as { data: unknown }).data);
    expect(models.models[0]?.input).toEqual(["text", "image"]);
  });

  it("decodes the real subagent payload shape", () => {
    const frame = decodeSubagent({
      type: "subagent_lifecycle",
      payload: {
        id: "sub-1",
        status: "completed",
        index: 0,
        description: "Review",
      },
    });
    expect(frame.type).toBe("subagent_lifecycle");
  });

  it("decodes a complete real assistant turn", () => {
    const values = frames("live-turn.jsonl");
    expect(decodeMessageStart(values[3]).message.role).toBe("user");
    expect(decodeMessageStart(values[5]).message.role).toBe("assistant");
    expect(decodeMessageUpdate(values[6])).toMatchObject({
      type: "message_update",
    });
    expect(decodeMessageEnd(values[8]).message.role).toBe("assistant");
    expect(decodeAgentEnd(values[10])).toMatchObject({
      type: "agent_end",
      isTerminal: true,
    });
  });

  it("preserves the real user message lifecycle for role-aware mapping", () => {
    const values = frames("prompt-events.jsonl");
    const messageStart = decodeMessageStart(values[3]);
    const messageEnd = decodeMessageEnd(values[4]);
    expect(messageStart.type).toBe("message_start");
    expect(messageEnd.type).toBe("message_end");
    expect(messageStart.message.role).toBe("user");
    expect(messageEnd.message.role).toBe("user");
  });
});
