import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { MessageId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import type { OptimisticUserMessage } from "../../scient/threadQueue/optimisticQueuePresentation";
import { useThreadTimelineEntries } from "./useThreadTimelineEntries";

const createdAt = "2026-10-17T00:00:00.000Z";
const message = (id: string, queued = false): OptimisticUserMessage => ({
  id: MessageId.make(id),
  role: "user",
  text: id,
  runId: null,
  createdAt,
  updatedAt: createdAt,
  streaming: false,
  ...(queued ? { queueAdmission: { threadKey: "thread", accepted: false } } : {}),
});

const NO_ITEMS: never[] = [];
const NO_URLS = new Map<string, string>();
const NO_HANDOFFS = {};
const NO_FEEDBACK: never[] = [];

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.container = document.createElement("div");
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.unstubAllGlobals();
}

function setup(_fixture: _Fixture, initialMessages: ReadonlyArray<OptimisticUserMessage>) {
  const seen: Array<ReturnType<typeof useThreadTimelineEntries>> = [];
  const controls: {
    rerender: () => void;
    setMessages: (messages: ReadonlyArray<OptimisticUserMessage>) => void;
  } = { rerender: () => undefined, setMessages: () => undefined };
  function Harness() {
    const [, setTick] = useState(0);
    const [messages, setMessages] = useState(initialMessages);
    useEffect(() => {
      controls.rerender = () => setTick((tick) => tick + 1);
      controls.setMessages = setMessages;
    }, []);
    seen.push(
      useThreadTimelineEntries({
        threadKey: "thread",
        visibleTurnItems: NO_ITEMS,
        projection: null,
        serverAttachmentUrlById: NO_URLS,
        attachmentPreviewHandoffByMessageId: NO_HANDOFFS,
        feedbackSubmissions: NO_FEEDBACK,
        optimisticMessages: messages,
      }),
    );
    return null;
  }
  return {
    controls,
    seen,
    // Every render records its result, so the record count is the render count.
    renders: () => seen.length,
    mount: async () => await act(async () => await _fixture.root0.rerender(<Harness />)),
  };
}

describe("useThreadTimelineEntries", () => {
  it("renders through ordinary updates without rebuilding the timeline", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const harness = setup(_fixture, [message("sent")]);
    await harness.mount();
    const first = harness.seen.at(-1)!;
    const rendersAfterMount = harness.renders();
    for (let update = 0; update < 5; update += 1) {
      await act(() => harness.controls.rerender());
    }
    // One render per update: no render-phase rebuild loop.
    expect(harness.renders()).toBe(rendersAfterMount + 5);
    const latest = harness.seen.at(-1)!;
    expect(latest.serverEntries).toBe(first.serverEntries);
    expect(latest.optimisticMessages).toBe(first.optimisticMessages);
  });

  it("rebuilds once for a new message and keeps queue admissions out of the timeline", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const harness = setup(_fixture, [message("sent")]);
    await harness.mount();
    await act(() => harness.controls.setMessages([message("sent"), message("queued", true)]));
    const latest = harness.seen.at(-1)!;
    expect(latest.optimisticMessages.map((entry) => entry.id)).toEqual(["sent"]);
    expect(
      latest.serverEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message.id] : [])),
    ).toEqual(["sent"]);
    const renders = harness.renders();
    await act(() => harness.controls.rerender());
    expect(harness.renders()).toBe(renders + 1);
    expect(harness.seen.at(-1)!.serverEntries).toBe(latest.serverEntries);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
