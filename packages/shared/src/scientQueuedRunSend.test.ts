import type { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  canSendQueuedRun,
  isQueueUsageLimitProven,
  queuedRunSendRefusal,
} from "./scientQueuedRunSend.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const runId = (id: string) => id as RunId;

function run(id: string, ordinal: number, status: string, extra: object = {}) {
  return {
    id,
    ordinal,
    status,
    userMessageId: `message:${id}`,
    queuePosition: status === "queued" ? ordinal : null,
    queueHeld: status === "queued",
    rootNodeId: `node:${id}`,
    startedAt: status === "queued" ? null : at("2026-10-07T00:00:00.000Z"),
    ...extra,
  };
}

function projection(input: {
  readonly runs: ReadonlyArray<object>;
  readonly messages?: ReadonlyArray<object>;
  readonly turnItems?: ReadonlyArray<object>;
  readonly providerSessions?: ReadonlyArray<object>;
}) {
  return {
    thread: { providerInstanceId: "codex" },
    runs: input.runs,
    messages: input.messages ?? [],
    turnItems: input.turnItems ?? [],
    providerSessions: input.providerSessions ?? [],
  } as never;
}

const usageLimitError = {
  id: "item:limit",
  type: "error",
  runId: "run:limited",
  nodeId: "node:run:limited",
  status: "failed",
  ordinal: 1,
  updatedAt: at("2026-10-07T00:00:01.000Z"),
  failure: { class: "usage_limit", message: "Usage limit reached." },
};

describe("canSendQueuedRun", () => {
  it("allows every queued message on an idle thread, not just the head", () => {
    const idle = projection({
      runs: [run("run:done", 1, "completed"), run("run:a", 2, "queued"), run("run:b", 3, "queued")],
    });
    expect(canSendQueuedRun(idle, runId("run:a"))).toBe(true);
    expect(canSendQueuedRun(idle, runId("run:b"))).toBe(true);
    expect(queuedRunSendRefusal(idle, runId("run:done"))).toBe("not_queued");
  });

  it.each(["preparing", "starting", "running", "waiting"])(
    "refuses while a %s run owns the thread",
    (status) => {
      const busy = projection({
        runs: [run("run:active", 1, status), run("run:a", 2, "queued")],
      });
      expect(canSendQueuedRun(busy, runId("run:a"))).toBe(false);
      expect(queuedRunSendRefusal(busy, runId("run:a"))).toBe("busy");
    },
  );

  it("refuses after the usage limit stopped the thread", () => {
    const limited = projection({
      runs: [run("run:limited", 1, "failed"), run("run:a", 2, "queued")],
      turnItems: [usageLimitError],
    });
    expect(queuedRunSendRefusal(limited, runId("run:a"))).toBeNull();
    expect(canSendQueuedRun(limited, runId("run:a"))).toBe(false);
  });

  it("lets a client refuse for the limit only when the server's shell confirms it", () => {
    const limited = projection({
      runs: [run("run:limited", 1, "failed"), run("run:a", 2, "queued")],
      turnItems: [usageLimitError],
    });
    expect(isQueueUsageLimitProven(limited, "usage_limit")).toBe(true);
    for (const shellClass of [null, undefined, "provider_error"]) {
      const usageLimited = isQueueUsageLimitProven(limited, shellClass);
      expect(usageLimited).toBe(false);
      expect(canSendQueuedRun(limited, runId("run:a"), { usageLimited })).toBe(true);
    }
    const idle = projection({ runs: [run("run:done", 1, "completed"), run("run:a", 2, "queued")] });
    expect(isQueueUsageLimitProven(idle, "usage_limit")).toBe(false);
  });

  it("allows Send when a newer session error supersedes the limit", () => {
    const recovered = projection({
      runs: [run("run:limited", 1, "failed"), run("run:a", 2, "queued")],
      turnItems: [usageLimitError],
      providerSessions: [
        {
          providerInstanceId: "codex",
          updatedAt: at("2026-10-07T00:00:02.000Z"),
          lastError: "The provider process exited.",
        },
      ],
    });
    expect(canSendQueuedRun(recovered, runId("run:a"))).toBe(true);
  });

  it("allows a user message behind a delegated completion, never the completion itself", () => {
    const delegated = projection({
      runs: [
        run("run:a", 2, "queued"),
        run("run:automatic", 3, "queued", { queueHeld: false }),
        run("run:notice", 4, "queued"),
      ],
      messages: [
        { id: "message:run:a" },
        {
          id: "message:run:automatic",
          delegatedCompletion: { parentRunId: "run:parent", generation: 1, taskIds: ["task"] },
        },
        { id: "message:run:notice", notification: { kind: "notice" } },
      ],
    });
    expect(canSendQueuedRun(delegated, runId("run:a"))).toBe(true);
    expect(queuedRunSendRefusal(delegated, runId("run:automatic"))).toBe("automatic");
    expect(queuedRunSendRefusal(delegated, runId("run:notice"))).toBe("automatic");
  });
});
