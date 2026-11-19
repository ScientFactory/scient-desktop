import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { turnItemHasDetail } from "./itemDetail.ts";

const tool = (output: unknown): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("tool"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: "Search papers",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-13T00:00:00Z"),
  type: "dynamic_tool",
  toolName: "search",
  input: {},
  output,
});

describe("a tool call with no arguments", () => {
  it("opens when it has output, and stays closed when it has nothing to show", () => {
    expect(turnItemHasDetail(tool({ content: [{ type: "text", text: "3 papers found." }] }))).toBe(
      true,
    );
    expect(turnItemHasDetail(tool(undefined))).toBe(false);
  });
});
