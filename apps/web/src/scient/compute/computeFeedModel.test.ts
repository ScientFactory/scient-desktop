import {
  ComputeExecutionId,
  ComputeSessionGeneration,
  ComputeSessionId,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computeFeedEntries } from "./computeFeedModel";
import { computeOutputBlocks } from "./computeOutputBlocks";

const session = (id: string, createdAt: string, generation = 1) =>
  ({
    sessionId: ComputeSessionId.make(id),
    createdAt,
    generation: ComputeSessionGeneration.make(generation),
  }) as ComputeSessionRecord;

const run = (id: string, submittedAt: string, generation: number) =>
  ({
    request: {
      executionId: ComputeExecutionId.make(id),
      submittedAt,
      generation: ComputeSessionGeneration.make(generation),
    },
    result: null,
  }) as ComputeExecutionRecord;

describe("computeFeedEntries", () => {
  it("orders runs oldest first, interleaves fresh runs and marks restarts", () => {
    const entries = computeFeedEntries({
      session: session("main", "2026-10-30T09:00:00Z", 3),
      executions: [
        run("c", "2026-10-30T09:03:00Z", 2),
        run("a", "2026-10-30T09:01:00Z", 1),
        run("b", "2026-10-30T09:02:00Z", 1),
      ],
      freshSessions: [session("fresh", "2026-10-30T09:02:30Z")],
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      "a",
      "b",
      "fresh",
      "restart:2",
      "c",
      "restart:3",
    ]);
  });
});

describe("computeOutputBlocks", () => {
  it("joins consecutive chunks of one stream into a single block", () => {
    const stream = (sequence: number, name: "stdout" | "stderr", text: string): ComputeOutput => ({
      _tag: "stream",
      sequence,
      observedAt: "2026-10-30T09:00:00Z",
      stream: name,
      text,
    });
    const blocks = computeOutputBlocks([
      stream(1, "stderr", "\r 50%"),
      stream(2, "stderr", "\r100%"),
      stream(3, "stdout", "done\n"),
      stream(4, "stderr", "\n"),
    ]);
    expect(blocks.map((block) => (block.kind === "stream" ? block.text : block.kind))).toEqual([
      "\r 50%\r100%",
      "done\n",
      "\n",
    ]);
  });
});
