/** Window-local reading receipts. Old history is a baseline, not newly unread. */
export interface UnreadTimelineMessages {
  known: Set<string>;
  unread: Set<string>;
  newestCreatedAt: string;
}

const threads = new Map<string, UnreadTimelineMessages>();

export function updateUnreadMessages(
  previous: UnreadTimelineMessages | undefined,
  messages: readonly { id: string; role: string; createdAt: string }[],
): UnreadTimelineMessages {
  const state = previous ?? {
    known: new Set<string>(),
    unread: new Set<string>(),
    newestCreatedAt: "",
  };
  const baseline = state.newestCreatedAt;
  for (const message of messages) {
    if (!state.known.has(message.id)) {
      if (previous && message.role === "assistant" && message.createdAt >= baseline)
        state.unread.add(message.id);
      state.known.add(message.id);
    }
    if (message.createdAt > state.newestCreatedAt) state.newestCreatedAt = message.createdAt;
  }
  return state;
}

export function unreadMessagesForThread(
  key: string,
  messages: readonly { id: string; role: string; createdAt: string }[],
) {
  const state = updateUnreadMessages(threads.get(key), messages);
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
