/** Window-local reading receipts. Old history is a baseline, not newly unread. */
export interface UnreadTimelineMessages {
  known: Set<string>;
  unread: Set<string>;
  newestCreatedAt: string;
}

const threads = new Map<string, UnreadTimelineMessages>();

/**
 * `countable` holds each response's latest assistant message (see
 * `deriveTerminalAssistantMessageIds`). A response counts once: the progress
 * notes an agent writes between tool calls are each the latest message when
 * they arrive, and stop counting as soon as a later message supersedes them.
 */
export function updateUnreadMessages(
  previous: UnreadTimelineMessages | undefined,
  messages: readonly { id: string; role: string; createdAt: string }[],
  countable?: ReadonlySet<string>,
): UnreadTimelineMessages {
  const state = previous ?? {
    known: new Set<string>(),
    unread: new Set<string>(),
    newestCreatedAt: "",
  };
  const baseline = state.newestCreatedAt;
  for (const message of messages) {
    if (!state.known.has(message.id)) {
      if (
        previous &&
        message.role === "assistant" &&
        message.createdAt >= baseline &&
        (!countable || countable.has(message.id))
      )
        state.unread.add(message.id);
      state.known.add(message.id);
    }
    if (message.createdAt > state.newestCreatedAt) state.newestCreatedAt = message.createdAt;
  }
  if (countable) for (const id of state.unread) if (!countable.has(id)) state.unread.delete(id);
  return state;
}

export function unreadMessagesForThread(
  key: string,
  messages: readonly { id: string; role: string; createdAt: string }[],
  countable?: ReadonlySet<string>,
) {
  const state = updateUnreadMessages(threads.get(key), messages, countable);
  threads.delete(key);
  threads.set(key, state);
  if (threads.size > 100) threads.delete(threads.keys().next().value!);
  return state;
}

/** Count only messages below the viewport; seeing any part records a reading receipt. */
export function countUnreadBelow(
  state: UnreadTimelineMessages,
  bounds: readonly { id: string; top: number; bottom: number }[],
  viewportTop: number,
  viewportBottom: number,
) {
  let count = 0;
  for (const message of bounds) {
    if (!state.unread.has(message.id)) continue;
    if (message.top < viewportBottom && message.bottom > viewportTop)
      state.unread.delete(message.id);
    else if (message.top >= viewportBottom) count++;
  }
  return count;
}
