import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { OmpSessionTree } from "./OmpSessionTree.ts";

const message = (id: string, parentId: string | null, role: string, timestamp: string) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role },
});
const EARLIER = "2026-11-13T10:00:00.000Z";
const LATER = "2026-11-13T10:05:00.000Z";
const SENT_AT = Date.parse("2026-11-13T10:04:00.000Z");

const peer = (entries: ReadonlyArray<ReturnType<typeof message>>) => {
  const requests: Array<string | null> = [];
  const command = (body: Record<string, unknown> & { readonly type: string }) => {
    const since = typeof body.since === "string" ? body.since : null;
    requests.push(since);
    const from = since === null ? 0 : entries.findIndex((entry) => entry.id === since) + 1;
    return from === 0 && since !== null
      ? Effect.fail(
          new OmpRpcCommandError({ command: "get_entries", detail: "Unknown entries cursor" }),
        )
      : Effect.succeed({
          type: "response",
          command: "get_entries",
          success: true,
          data: { entries: entries.slice(from), leafId: entries.at(-1)?.id ?? null },
        } as OmpRpcResponse);
  };
  return { command, requests };
};

it.effect("finds the turn's own message, not a steer or an earlier turn, from a full listing", () =>
  Effect.gen(function* () {
    const { command, requests } = peer([
      message("u0", null, "user", EARLIER),
      message("a0", "u0", "assistant", EARLIER),
      message("u1", "a0", "user", LATER),
      message("steer", "u1", "user", LATER),
      message("a1", "steer", "assistant", LATER),
    ]);
    const tree = new OmpSessionTree();
    assert.strictEqual(yield* tree.turnStart(command, "/s.jsonl", SENT_AT), "u1");
    assert.deepEqual(requests, [null]);
  }),
);

it.effect("lists the whole tree again when its cursor is no longer in the file", () =>
  Effect.gen(function* () {
    const first = peer([
      message("u1", null, "user", LATER),
      message("a1", "u1", "assistant", LATER),
    ]);
    const tree = new OmpSessionTree();
    yield* tree.turnStart(first.command, "/s.jsonl", SENT_AT);
    const rewritten = peer([message("u2", null, "user", LATER)]);
    assert.strictEqual(yield* tree.turnStart(rewritten.command, "/s.jsonl", SENT_AT), "u2");
    assert.deepEqual(rewritten.requests, ["a1", null]);
  }),
);
