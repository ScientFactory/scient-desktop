import "../../index.css";
import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MessagesTimeline } from "./MessagesTimeline";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("entrance-motion-tests");
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
      turnId: TurnId.make(`turn-${index}`),
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  };
}
const base = {
  listRef,
  isWorking: false,
  activeTurnStartedAt: null,
  latestTurn: null,
  runningTurnId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  contentInsetEndAdjustment: 100,
  onIsAtEndChange: vi.fn(),
  onManualNavigation: () => {},
};
const frames = async (count = 4) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
function render(
  key: string,
  entries: React.ComponentProps<typeof MessagesTimeline>["timelineEntries"],
  extra: Partial<React.ComponentProps<typeof MessagesTimeline>> = {},
) {
  if (!host) {
    host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "600px" });
    document.body.append(host);
    root = createRoot(host);
  }
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

const animationsOf = (element: Element | null | undefined) =>
  element
    ? element
        .getAnimations()
        // Script entrances only, not the stylesheet's own transitions.
        .filter(
          (animation) =>
            !(animation instanceof CSSTransition) &&
            !(animation instanceof CSSAnimation) &&
            animation.playState !== "finished",
        )
    : [];
const working = { isWorking: true, runningTurnId: TurnId.make("turn-1") };

it("darkens the working header in once per prompt, not again when its row remounts", async () => {
  const prompt = entry(1, "First question");
  render("motion:working", [prompt], working);
  const line = () => host!.querySelector('[data-timeline-row-kind="working"] .border-b');
  await expect.poll(() => line()).not.toBeNull();
  expect(animationsOf(line())).toHaveLength(1);
  // Shown at once (faint, not hidden), at its full size: masking only, nothing moves.
  expect(line()!.getBoundingClientRect().width).toBeGreaterThan(100);
  expect(getComputedStyle(line()!).opacity).toBe("1");
  const style = getComputedStyle(line()!);
  expect(`${style.maskImage} ${style.webkitMaskImage}`).toContain("linear-gradient");
  // The list remounts the row (thread switch and back): no replay.
  render("motion:other", [entry(50, "Elsewhere")]);
  await frames(4);
  render("motion:working", [prompt], working);
  await expect.poll(() => line()).not.toBeNull();
  expect(animationsOf(line())).toHaveLength(0);
  // A new prompt's working line draws in again.
  render("motion:working", [prompt, entry(2, "Second question")], {
    ...working,
    runningTurnId: TurnId.make("turn-2"),
  });
  await frames(4);
  expect(animationsOf(line())).toHaveLength(1);
});

it("plays the entrance for a first prompt being placed, and for no other prompt", async () => {
  const first = entry(1, "First question");
  render("motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  const bubble = (id: string) =>
    host!.querySelector(`[data-message-id="${id}"] .group.flex.flex-col.items-end`);
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(1);
  // Its row remounts while it is still being placed: no replay.
  render("motion:elsewhere", [entry(60, "Elsewhere")]);
  await frames(4);
  render("motion:first", [first], {
    anchorMessageId: first.message.id,
    timelinePositioningPending: true,
  });
  await expect.poll(() => bubble(first.message.id)).not.toBeNull();
  expect(animationsOf(bubble(first.message.id))).toHaveLength(0);
  const later = entry(2, "Later question");
  render("motion:first", [first, later], { anchorMessageId: first.message.id });
  await expect.poll(() => bubble(later.message.id)).not.toBeNull();
  expect(animationsOf(bubble(later.message.id))).toHaveLength(0);
});

it("fades each new paragraph of a streaming answer in, once, and nothing else", async () => {
  const prompt = entry(1, "Question");
  const answer = (text: string, streaming: boolean) => ({
    ...entry(2, text),
    message: { ...entry(2, text).message, role: "assistant" as const, streaming },
  });
  const paragraphs = () =>
    Array.from(host!.querySelectorAll('[data-message-role="assistant"] .chat-markdown p'));
  render("motion:stream", [prompt, answer("First paragraph.", true)], working);
  await expect.poll(() => paragraphs().length).toBe(1);
  // Text already shown when the message mounts does not animate.
  expect(animationsOf(paragraphs()[0])).toHaveLength(0);
  render("motion:stream", [prompt, answer("First paragraph.\n\nSecond paragraph.", true)], working);
  await expect.poll(() => paragraphs().length).toBe(2);
  expect(animationsOf(paragraphs()[0])).toHaveLength(0);
  expect(animationsOf(paragraphs()[1])).toHaveLength(1);
  // A finished message's changes never animate.
  render(
    "motion:stream",
    [prompt, answer("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", false)],
    { isWorking: false },
  );
  await expect.poll(() => paragraphs().length).toBe(3);
  expect(animationsOf(paragraphs()[2])).toHaveLength(0);
});
