import type {
  EnvironmentId,
  ScientThreadQueueItemId,
  ScientThreadQueueSnapshot,
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueUpdateRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePreparedConnection } from "../../state/session";
import {
  controlThreadQueue,
  enqueueThreadQueueItem,
  listThreadQueue,
  removeThreadQueueItem,
  reorderThreadQueue,
  updateThreadQueueItem,
} from "./client";

/** A view of server-owned delivery. No render or navigation can dispatch a turn. */
export function useThreadQueue(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly threadBusy: boolean;
}) {
  const { environmentId, threadId } = input;
  const key = JSON.stringify([environmentId, threadId]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<{
    key: string;
    snapshot: ScientThreadQueueSnapshot | null;
    error: string | null;
  }>({ key, snapshot: null, error: null });
  const [optimisticOrder, setOptimisticOrder] = useState<{
    key: string;
    ids: ReadonlyArray<string>;
    sequence: number;
  } | null>(null);
  const reorderSequence = useRef(0);
  const reorderTail = useRef<Promise<unknown>>(Promise.resolve());
  const refreshInFlight = useRef<string | null>(null);
  const revisionRef = useRef<{ key: string; revision: number | undefined }>({
    key,
    revision: undefined,
  });
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const accept = useCallback(
    (snapshot: ScientThreadQueueSnapshot) => {
      if (currentKey.current !== key || snapshot.threadId !== threadId) return;
      if (snapshot.unchanged) {
        setState((old) => (old.key === key && old.error !== null ? { ...old, error: null } : old));
        return snapshot;
      }
      if (
        revisionRef.current.key === key &&
        (revisionRef.current.revision ?? -1) > (snapshot.revision ?? 0)
      )
        return snapshot;
      revisionRef.current = { key, revision: snapshot.revision };
      setState((old) =>
        old.key === key && (old.snapshot?.revision ?? -1) > (snapshot.revision ?? 0)
          ? old
          : { key, snapshot, error: null },
      );
      return snapshot;
    },
    [key, threadId],
  );
  const fail = useCallback(
    (cause: unknown) => {
      if (currentKey.current === key)
        setState((old) => ({
          key,
          snapshot: old.key === key ? old.snapshot : null,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
    },
    [key],
  );
  const refresh = useCallback(async () => {
    if (!environmentId || !threadId || refreshInFlight.current === key) return;
    refreshInFlight.current = key;
    try {
      accept(
        await listThreadQueue(
          environmentId,
          threadId,
          revisionRef.current.key === key ? revisionRef.current.revision : undefined,
        ),
      );
    } catch (cause) {
      fail(cause);
    } finally {
      if (refreshInFlight.current === key) refreshInFlight.current = null;
    }
  }, [environmentId, threadId, key, accept, fail]);
  useEffect(() => {
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [connected, refresh]);
  const scope = () => {
    if (!environmentId || !threadId) throw new Error("No active thread for the queue.");
    return { environmentId, threadId };
  };
  const mutate = async (operation: () => Promise<ScientThreadQueueSnapshot>) => {
    try {
      const result = await operation();
      accept(result);
      return result;
    } catch (cause) {
      fail(cause);
      throw cause;
    }
  };
  const enqueue = (payload: Omit<ScientThreadQueueEnqueueRequest, "threadId">) => {
    const target = scope();
    return mutate(() =>
      enqueueThreadQueueItem(target.environmentId, { threadId: target.threadId, ...payload }),
    );
  };
  const update = (payload: Omit<ScientThreadQueueUpdateRequest, "threadId">) => {
    const target = scope();
    return mutate(() =>
      updateThreadQueueItem(target.environmentId, { threadId: target.threadId, ...payload }),
    );
  };
  const remove = (queueItemId: string) => {
    const target = scope();
    return mutate(() =>
      removeThreadQueueItem(target.environmentId, { threadId: target.threadId, queueItemId }),
    );
  };
  const reorder = (queueItemIds: ReadonlyArray<ScientThreadQueueItemId>) => {
    const target = scope();
    const sequence = ++reorderSequence.current;
    setOptimisticOrder({ key, ids: queueItemIds, sequence });
    const pending = reorderTail.current
      .catch(() => undefined)
      .then(() =>
        mutate(() =>
          reorderThreadQueue(target.environmentId, { threadId: target.threadId, queueItemIds }),
        ),
      );
    reorderTail.current = pending;
    return pending.finally(() =>
      setOptimisticOrder((order) =>
        order?.key === key && order.sequence === sequence ? null : order,
      ),
    );
  };
  const control = (
    action: "edit" | "resume" | "steer",
    queueItemId?: string,
    editToken?: string,
  ) => {
    const target = scope();
    return mutate(() =>
      controlThreadQueue(target.environmentId, {
        threadId: target.threadId,
        action,
        ...(queueItemId ? { queueItemId } : {}),
        ...(editToken ? { editToken } : {}),
      }),
    );
  };
  const snapshot = state.key === key ? state.snapshot : null;
  const visibleItems = snapshot?.items.filter((item) => item.state !== "editing") ?? [];
  if (optimisticOrder?.key === key) {
    const rank = new Map(optimisticOrder.ids.map((id, index) => [id, index]));
    visibleItems.sort(
      (a, b) => (rank.get(a.queueItemId) ?? Infinity) - (rank.get(b.queueItemId) ?? Infinity),
    );
  }
  return {
    items: visibleItems,
    editingItems: snapshot?.items.filter((item) => item.state === "editing") ?? [],
    error:
      state.key === key
        ? (state.error ?? (snapshot?.items.length ? snapshot.paused : null) ?? null)
        : null,
    paused: snapshot?.paused ?? null,
    awaitingCompletion: snapshot?.awaitingCompletion ?? false,
    enqueue,
    update,
    remove,
    reorder,
    control,
    refresh,
  };
}
