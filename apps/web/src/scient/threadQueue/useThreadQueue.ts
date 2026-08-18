import type {
  EnvironmentId,
  ScientThreadQueueItem,
  ScientThreadQueueItemId,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  enqueueThreadQueueItem,
  listThreadQueue,
  removeThreadQueueItem,
  reorderThreadQueue,
  updateThreadQueueItem,
} from "./client";

/**
 * State and mutations for one thread's Scient message queue. Every mutation
 * returns the authoritative snapshot from the server, so the hook never
 * guesses queue contents; reorder is the one optimistic path (drag and drop
 * feels broken otherwise) and rolls back through a refetch on failure.
 *
 * The queue never dispatches by itself. Sending a queued item is the caller's
 * job and always goes through the ordinary thread.turn.start flow.
 */
export function useThreadQueue(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** Drives a cheap cross-device refresh when a turn settles. */
  readonly threadBusy: boolean;
}) {
  const { environmentId, threadId, threadBusy } = input;
  const [items, setItems] = useState<ReadonlyArray<ScientThreadQueueItem>>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  // Mutations resolve asynchronously; a thread switch in the meantime must not
  // let a stale snapshot overwrite the freshly loaded one.
  const contextRef = useRef({ environmentId, threadId });
  contextRef.current = { environmentId, threadId };
  const isCurrentContext = useCallback(
    () =>
      contextRef.current.environmentId === environmentId &&
      contextRef.current.threadId === threadId,
    [environmentId, threadId],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!environmentId || !threadId) {
      setItems([]);
      setError(null);
      return;
    }
    try {
      const snapshot = await listThreadQueue(environmentId, threadId);
      if (generation.current === request) {
        setItems(snapshot.items);
        setError(null);
      }
    } catch (cause) {
      if (generation.current === request) {
        setError(cause instanceof Error ? cause.message : "The message queue could not be read.");
      }
    }
  }, [environmentId, threadId]);

  useEffect(() => {
    setItems([]);
    setError(null);
    void refresh();
  }, [refresh]);

  // Another device may have dispatched or edited the queue while this thread
  // was running here. The running -> idle transition is the one moment the
  // queue can have changed without this client knowing, so resync then.
  const previousBusy = useRef(threadBusy);
  useEffect(() => {
    const wasBusy = previousBusy.current;
    previousBusy.current = threadBusy;
    if (wasBusy && !threadBusy) void refresh();
  }, [threadBusy, refresh]);

  const enqueue = useCallback(
    async (enqueueInput: {
      readonly text: string;
      readonly attachments: ReadonlyArray<UploadChatAttachment>;
    }) => {
      if (!environmentId || !threadId) throw new Error("No active thread for the queue.");
      const snapshot = await enqueueThreadQueueItem(environmentId, {
        threadId,
        text: enqueueInput.text,
        attachments: enqueueInput.attachments,
      });
      if (isCurrentContext()) setItems(snapshot.items);
      return snapshot;
    },
    [environmentId, threadId, isCurrentContext],
  );

  const remove = useCallback(
    async (queueItemId: ScientThreadQueueItemId) => {
      if (!environmentId || !threadId) throw new Error("No active thread for the queue.");
      const snapshot = await removeThreadQueueItem(environmentId, { threadId, queueItemId });
      if (isCurrentContext()) setItems(snapshot.items);
      return snapshot;
    },
    [environmentId, threadId, isCurrentContext],
  );

  const update = useCallback(
    async (updateInput: {
      readonly queueItemId: ScientThreadQueueItemId;
      readonly text: string;
      readonly attachments: ReadonlyArray<UploadChatAttachment>;
    }) => {
      if (!environmentId || !threadId) throw new Error("No active thread for the queue.");
      const snapshot = await updateThreadQueueItem(environmentId, {
        threadId,
        queueItemId: updateInput.queueItemId,
        text: updateInput.text,
        attachments: updateInput.attachments,
      });
      if (isCurrentContext()) setItems(snapshot.items);
      return snapshot;
    },
    [environmentId, threadId, isCurrentContext],
  );

  const reorder = useCallback(
    async (queueItemIds: ReadonlyArray<ScientThreadQueueItemId>) => {
      if (!environmentId || !threadId) throw new Error("No active thread for the queue.");
      const rank = new Map(queueItemIds.map((id, index) => [id, index] as const));
      setItems((current) =>
        [...current].sort(
          (left, right) =>
            (rank.get(left.queueItemId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.queueItemId) ?? Number.MAX_SAFE_INTEGER),
        ),
      );
      try {
        const snapshot = await reorderThreadQueue(environmentId, { threadId, queueItemIds });
        if (isCurrentContext()) setItems(snapshot.items);
        return snapshot;
      } catch (cause) {
        if (isCurrentContext()) void refresh();
        throw cause;
      }
    },
    [environmentId, threadId, isCurrentContext, refresh],
  );

  return { items, error, enqueue, update, remove, reorder, refresh };
}
