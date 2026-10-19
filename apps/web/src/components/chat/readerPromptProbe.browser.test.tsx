import "../../index.css";
import { EnvironmentId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { StrictMode, createRef, useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { readerAtReadingEnd, readingEndGapOnScreen, withReadingEnd } from "./readerScrollPolicy";
import { MessagesTimeline } from "./MessagesTimeline";
import { HandoffRow } from "./V2LifecycleRow";
import { useTimelineEndControl } from "./useTimelineEndControl";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("scroll-geometry-tests");
const date = "2026-09-29T00:00:00.000Z";
function entry(index: number, text = `Message ${index}\n\n${"Readable paragraph. ".repeat(28)}`) {
  return {
    kind: "message" as const,
    id: `entry-${index}`,
    createdAt: date,
    message: {
      id: MessageId.make(`message-${index}`),
      role: "user" as const,
      text,
      runId: RunId.make(`run-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  };
}
const base = {
  listRef,
  isWorking: false,
  activeTurnInProgress: false,
  activeTurnStartedAt: null,
  latestRun: null,
  runningRunId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  onOpenThread: () => {},
  onForkFromRun: () => Promise.resolve(),
  onRollbackCheckpoint: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  runs: [],
  providerStatuses: [],
  anchorMessageId: null,
  onAnchorReady: () => {},
  onAnchorSizeChanged: () => {},
  contentInsetEndAdjustment: 100,
  onIsAtEndChange: vi.fn(),
  onManualNavigation: () => {},
};
const frames = async (count = 4) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
function mountHost() {
  if (!host) {
    host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "600px" });
    document.body.append(host);
    root = createRoot(host);
  }
}
function render(
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  mountHost();
  flushSync(() =>
    root!.render(
      <MessagesTimeline {...base} routeThreadKey={key} timelineEntries={entries} {...extra} />,
    ),
  );
}
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

for (let run = 0; run < 40; run++)
  it(`PROBE prompt visible ${run}`, async () => {
    const key = `geometry:fast-answer-${run}`;
    const entries = Array.from({ length: 10 }, (_, i) => entry(i));
    render(key, entries);
    await expect.poll(() => readTimelinePosition(key), { timeout: 8000 }).toBeDefined();
    const prompt = entry(10, "New question");
    const answer = {
      ...entry(11),
      message: {
        ...entry(11).message,
        role: "assistant" as const,
        text: "Beginning of a fast answer.\n\n".repeat(90),
      },
    };
    const extra = { readingFollowPromptId: prompt.message.id };
    render(key, [...entries, prompt, answer], { ...extra, timelinePositioningPending: true });
    await frames(4);
    const list = listRef.current!;
    const node = list.getScrollableNode()!;
    const log: string[] = [];
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(node, "scrollTop", {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: number) {
        log.push(
          `set ${proto.get!.call(this).toFixed(1)} -> ${v.toFixed?.(1)} @ ${(
            new Error().stack ?? ""
          )
            .split("\n")
            .slice(2, 5)
            .map((l) =>
              l
                .trim()
                .replace(/\(?http:\/\/localhost:\d+\/src\//, "")
                .replace(/\?[^:]*/, ""),
            )
            .join(" < ")}`,
        );
        proto.set!.call(this, v);
      },
    });
    const top = () => {
      const state = list.getState();
      const i = state.data.findIndex(
        (row: { message?: { id: string } }) => row.message?.id === prompt.message.id,
      );
      const el = state.elementAtIndex(i)?.querySelector('[data-user-message-body="true"]');
      return el ? el.getBoundingClientRect().top - node.getBoundingClientRect().top : NaN;
    };
    render(key, [...entries, prompt, answer], extra);
    const samples: string[] = [];
    for (let i = 0; i < 300; i++) {
      await frames(1);
      samples.push(`${i}:${top().toFixed(1)}/${node.scrollTop.toFixed(0)}/${node.scrollHeight}`);
      if (top() <= 25 && i > 5) break;
    }
    const final = top();
    expect(
      final,
      `PROBE final=${final.toFixed(1)} finish=${JSON.stringify((globalThis as any).__followFinish)} samples=${samples.slice(0, 12).join(" ")} ... ${samples.slice(-4).join(" ")} writes=${log.length} first=${log.slice(0, 6).join(" | ")} last=${log.slice(-4).join(" | ")}`,
    ).toBeLessThanOrEqual(25);
  });
