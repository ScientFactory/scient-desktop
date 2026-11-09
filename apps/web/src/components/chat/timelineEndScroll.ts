import type { LegendListRef } from "@legendapp/list/react";

/**
 * Scrolls the timeline to its last line. Legend aims at the footer size it last measured, and a
 * footer that has just grown is measured a frame later, so its command can stop short of the end
 * and nothing corrects it. The page's own layout already includes the footer, so the scroll
 * finishes there.
 */
export async function scrollTimelineToEnd(
  list: LegendListRef | null | undefined,
  options: { readonly animated: boolean },
): Promise<void> {
  if (!list) return;
  await list.scrollToEnd(options);
  const node = list.getScrollableNode() as HTMLElement | null | undefined;
  if (!node) return;
  const end = node.scrollHeight - node.clientHeight;
  if (end - node.scrollTop > 1) node.scrollTo({ top: end, behavior: "instant" });
}
