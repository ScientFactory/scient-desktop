// @vitest-environment jsdom
import { MessageId } from "@t3tools/contracts";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

function setup(initialMessages: ReadonlyArray<OptimisticUserMessage>) {
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
    mount: () => act(() => root.render(<Harness />)),
  };
}

describe("useThreadTimelineEntries", () => {
  it("renders through ordinary updates without rebuilding the timeline", async () => {
    const harness = setup([message("sent")]);
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
    const harness = setup([message("sent")]);
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
