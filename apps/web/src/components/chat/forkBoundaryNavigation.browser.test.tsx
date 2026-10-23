import { render as _fixtureRender, type Screen } from "../../../test/render";
import { EnvironmentId, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vite-plus/test";
import { V2LifecycleRow } from "./V2LifecycleRow";

const decodeBoundaryItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

it.each(["run", "message"] as const)(
  "opens the exact origin of a persisted %s boundary",
  async (sourceType) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    await _fixture.root0.rerender(
      <V2LifecycleRow
        item={item}
        environmentId={EnvironmentId.make("test-env")}
        createdAt={DateTime.formatIso(now)}
        timestampFormat="locale"
        runs={[]}
        onOpenThread={onOpenThread}
      />,
    );
    await page.getByRole("button", { name: "Open source conversation" }).click();
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(sourceThreadId);
    expect(onOpenThread).not.toHaveBeenCalledWith(targetThreadId);
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
