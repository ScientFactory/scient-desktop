import { MessageId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import type { ChatMessage } from "../types";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

it("reconciles equivalent input allocations without restarting and still publishes real changes", async () => {
  const source = makeStreamingTimelineFixture("Answer");
  let latest: ReturnType<typeof useIncrementalTimelineEntries> | undefined;
  function Owner({ threadKey, feedback }: { threadKey: string; feedback: string }) {
    const anchored: ChatMessage = {
      id: MessageId.make("feedback"),
      role: "assistant",
      text: feedback,
      runId: null,
      streaming: false,
      createdAt: source.time(20),
      updatedAt: source.time(20),
    };
    const entries = useIncrementalTimelineEntries(threadKey, {
      visibleTurnItems: source.visibleTurnItems.slice(),
      optimisticMessages: [],
      anchoredMessages: [{ ...anchored }],
      attachmentUrlById: new Map(),
      attempts: [],
      nodes: [],
      plans: [],
    });
    useLayoutEffect(() => {
      latest = entries;
    }, [entries]);
    return entries.map((entry) =>
      entry.kind === "message" ? <p key={entry.id}>{entry.message.text}</p> : null,
    );
  }
  const read = () => {
    if (latest === undefined) throw new Error("Timeline did not commit");
    return latest;
  };
  // Scoped identity is supplied directly; the derivation does not read a router.
  await using screen = await render(<Owner threadKey="a:same-thread" feedback="Uploading" />, {
    router: false,
  });
  const original = read();
  await screen.rerender(<Owner threadKey="a:same-thread" feedback="Uploading" />);
  expect(read()).toBe(original);
  await screen.rerender(<Owner threadKey="a:same-thread" feedback="Sent" />);
  await expect.element(screen.getByText("Sent", { exact: true })).toBeVisible();
  expect(read()).not.toBe(original);
  const updated = read();
  await screen.rerender(<Owner threadKey="a:same-thread" feedback="Sent" />);
  expect(read()).toBe(updated);
  await screen.rerender(<Owner threadKey="b:same-thread" feedback="Sent" />);
  expect(read()).not.toBe(updated);
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Answer", { exact: true })).toBeVisible();
});
