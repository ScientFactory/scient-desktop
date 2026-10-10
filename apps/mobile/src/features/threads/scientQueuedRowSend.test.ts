import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { canSendScientQueuedRow } from "./scientQueuedRowSend";

const at = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");
const runId = (id: string) => id as RunId;

function run(id: string, ordinal: number, status: string) {
  return {
    id,
    ordinal,
    status,
    userMessageId: `message:${id}`,
    queuePosition: status === "queued" ? ordinal : null,
    queueHeld: status === "queued",
    rootNodeId: `node:${id}`,
    startedAt: status === "queued" ? null : at,
  };
}

function projection(runs: ReadonlyArray<object>, turnItems: ReadonlyArray<object> = []) {
  return {
    thread: { providerInstanceId: "codex" },
    runs,
    messages: [],
    turnItems,
    providerSessions: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const idleHeld = projection([
  run("run:stopped", 1, "interrupted"),
  run("run:a", 2, "queued"),
  run("run:b", 3, "queued"),
]);

const row = (overrides: Partial<Parameters<typeof canSendScientQueuedRow>[0]> = {}) =>
  canSendScientQueuedRow({
    projection: idleHeld,
    isHeld: true,
    shellLastErrorClass: null,
    runId: runId("run:b"),
    busy: false,
    isEditing: false,
    ...overrides,
  });

describe("mobile queued row Send", () => {
  it("offers Send on every held row of an idle thread, not just the head", () => {
    expect(row({ runId: runId("run:a") })).toBe(true);
    expect(row({ runId: runId("run:b") })).toBe(true);
  });

  it("offers no Send while the queue is not held, a turn runs, or the row is busy or edited", () => {
    expect(row({ isHeld: false })).toBe(false);
    expect(row({ busy: true })).toBe(false);
    expect(row({ isEditing: true })).toBe(false);
    expect(
      row({ projection: projection([run("run:active", 1, "running"), run("run:b", 2, "queued")]) }),
    ).toBe(false);
  });

  it("hides Send for a usage limit only when the server's shell confirms it", () => {
    const limited = projection(
      [run("run:limited", 1, "failed"), run("run:b", 2, "queued")],
      [
        {
          id: "item:limit",
          type: "error",
          runId: "run:limited",
          nodeId: "node:run:limited",
          status: "failed",
          ordinal: 1,
          updatedAt: at,
          failure: { class: "usage_limit", message: "Usage limit reached." },
        },
      ],
    );
    expect(row({ projection: limited, shellLastErrorClass: "usage_limit" })).toBe(false);
    expect(row({ projection: limited, shellLastErrorClass: null })).toBe(true);
  });
});
