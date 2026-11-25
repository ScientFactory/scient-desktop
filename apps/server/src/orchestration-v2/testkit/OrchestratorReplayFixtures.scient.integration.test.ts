import { assert, describe, it } from "@effect/vitest";
import { type ProviderReplayEntry } from "@t3tools/contracts";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { projectionFor } from "./fixtures/shared.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";

function requiredClaudeFixture(name: string) {
  const fixture = findReplayFixture(name);
  const provider = fixture?.providers.find((candidate) => candidate.driver === "claudeAgent");
  if (fixture === undefined || provider === undefined) {
    throw new Error(`Replay fixture ${name} has no claudeAgent recording.`);
  }
  return { fixture, provider };
}

describe("Claude background subagent replay regressions", () => {
  const { fixture: afterRootFixture, provider: afterRootProvider } = requiredClaudeFixture(
    "claude_background_subagent_after_root",
  );
  const OPEN_TOOL_ID = "toolu_01QDa5jV5g1H9h6QyDfeJohD";
  const SUBAGENT_TASK_ID = "a2995bfced8019363";

  const moveOpenToolBeforeRootResult = (
    move: boolean,
    entries: ReadonlyArray<ProviderReplayEntry>,
  ): ReadonlyArray<ProviderReplayEntry> => {
    if (!move) return entries;
    const toolIndex = entries.findIndex(
      (entry) =>
        entry.type === "emit_inbound" &&
        (entry.frame as Record<string, any>).message?.content?.[0]?.id === OPEN_TOOL_ID,
    );
    const resultIndex = entries.findIndex(
      (entry) => entry.type === "emit_inbound" && entry.label === "result",
    );
    if (toolIndex < 0 || resultIndex < 0) throw new Error("transcript shape changed");
    const toolEntry = entries[toolIndex]!;
    const rest = entries.filter((_, index) => index !== toolIndex);
    return [...rest.slice(0, resultIndex), toolEntry, ...rest.slice(resultIndex)];
  };

  // regression: a8c4802418 fix(server): a background Claude subagent's work shows while its parent is idle (#16486)

  // ClaudeReplayFixtures.integration.test.ts runs the other two rows of this matrix.
  it.effect.each([
    ["WebFetch", "before root settles", "stopped"],
    ["WebFetch", "before root settles", "failed"],
    ["WebFetch", "while root is idle", "failed"],
    ["Write", "before root settles", "stopped"],
    ["Write", "while root is idle", "stopped"],
    ["Write", "while root is idle", "failed"],
  ] as const)(
    "ends a background subagent's open %s (opened %s) when its notification is %s",
    ([tool, opens, notificationStatus]) =>
      runReplayFixture({
        harness: ClaudeOrchestratorReplayHarness,
        fixtureName: afterRootFixture.name,
        buildInput: afterRootFixture.buildInput,
        driver: {
          ...afterRootProvider,
          assertOutput: (result) => {
            const parent = projectionFor(result, afterRootFixture.name);
            assert.deepEqual(
              parent.runs.map((run) => run.status),
              ["completed", "completed"],
            );
            const subagent = parent.subagents[0];
            assert.equal(
              subagent?.status,
              notificationStatus === "stopped" ? "cancelled" : "failed",
            );
            const childThreadId = subagent?.childThreadId;
            assert.exists(childThreadId);
            const child = result.projections.get(childThreadId);
            assert.exists(child);
            const fetches = child.turnItems.filter(
              (item) => item.type === (tool === "WebFetch" ? "web_search" : "file_change"),
            );
            assert.lengthOf(fetches, 1, `the ${tool} reached the child thread`);
            assert.deepEqual(
              {
                openTool: fetches.map((item) => item.status),
                openChildNodes: child.nodes
                  .filter(
                    (node) =>
                      node.status === "running" ||
                      node.status === "pending" ||
                      node.status === "waiting",
                  )
                  .map((node) => `${node.kind}:${node.status}`),
              },
              {
                openTool: [notificationStatus === "stopped" ? "interrupted" : "failed"],
                openChildNodes: [],
              },
            );
          },
        },
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: moveOpenToolBeforeRootResult(
            opens === "before root settles",
            transcript.entries.flatMap((entry): ReadonlyArray<ProviderReplayEntry> => {
              if (entry.type !== "emit_inbound") return [entry];
              const frame = entry.frame as Record<string, any>;
              if (frame.type === "assistant" && frame.message?.content?.[0]?.id === OPEN_TOOL_ID) {
                return [
                  {
                    ...entry,
                    frame: {
                      ...frame,
                      message: {
                        ...frame.message,
                        content: [
                          {
                            ...frame.message.content[0],
                            name: tool,
                            input:
                              tool === "WebFetch"
                                ? { url: "https://example.com", prompt: "Summarize" }
                                : { file_path: "notes.txt", content: "SUB_DONE_2" },
                          },
                        ],
                      },
                    },
                  },
                ];
              }
              if (
                (frame.type === "system" &&
                  (frame.subtype === "task_started" || frame.subtype === "task_notification") &&
                  frame.tool_use_id === OPEN_TOOL_ID) ||
                (frame.type === "user" &&
                  frame.message?.content?.[0]?.tool_use_id === OPEN_TOOL_ID) ||
                (frame.type === "assistant" &&
                  frame.parent_tool_use_id !== null &&
                  frame.message?.content?.[0]?.text === "SUB_FINAL_REPORT")
              ) {
                return [];
              }
              if (frame.type === "system" && frame.subtype === "task_updated") {
                return [
                  {
                    ...entry,
                    frame: {
                      ...frame,
                      patch: {
                        ...frame.patch,
                        status: notificationStatus === "stopped" ? "killed" : "failed",
                      },
                    },
                  },
                ];
              }
              if (
                frame.type === "system" &&
                frame.subtype === "task_notification" &&
                frame.task_id === SUBAGENT_TASK_ID
              ) {
                return [{ ...entry, frame: { ...frame, status: notificationStatus } }];
              }
              return [entry];
            }),
          ),
        }),
      }),
  );
});
