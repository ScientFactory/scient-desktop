import { EnvironmentId, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import "../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { V2LifecycleRow } from "./V2LifecycleRow";

const decodeBoundaryItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

it.each(["run", "message"] as const)(
  "opens the exact origin of a persisted %s boundary",
  async (sourceType) => {
    const sourceThreadId = ThreadId.make("origin-fork");
    const targetThreadId = ThreadId.make("destination-fork");
    const onOpenThread = vi.fn();
    const now = DateTime.makeUnsafe("2026-10-04T12:00:00.000Z");
    const item = decodeBoundaryItem({
      id: "local-fork-boundary",
      threadId: targetThreadId,
      type: "fork",
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: "Conversation forked here",
      startedAt: null,
      completedAt: now,
      updatedAt: now,
      targetThreadId,
      source:
        sourceType === "run"
          ? { type: "run", threadId: sourceThreadId, runId: "source-run" }
          : {
              type: "message",
              threadId: sourceThreadId,
              messageId: "historical-answer",
              position: "after",
            },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <V2LifecycleRow
        item={item}
        environmentId={EnvironmentId.make("test-env")}
        createdAt={DateTime.formatIso(now)}
        timestampFormat="locale"
        providerStatuses={[]}
        runs={[]}
        onOpenThread={onOpenThread}
      />,
    );
    await page.getByRole("button", { name: "Open source conversation" }).click();
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(sourceThreadId);
    expect(onOpenThread).not.toHaveBeenCalledWith(targetThreadId);
  },
);
