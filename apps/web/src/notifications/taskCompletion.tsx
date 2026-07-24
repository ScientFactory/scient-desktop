// FILE: taskCompletion.tsx
// Purpose: Bridges thread completion and attention-needed events to Activity and OS notifications.
// Layer: Notification runtime
// Exports: TaskCompletionNotifications and browser permission helpers

import { ThreadId } from "@synara/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { resolveVisibleToastThreadIds } from "../components/ui/toastRouteVisibility";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { createAllThreadsSelector } from "../storeSelectors";
import { useTerminalStateStore } from "../terminalStateStore";
import type { Thread } from "../types";
import {
  activityManager,
  type ActivitySource,
  type ActivityStatus,
  useActivityStore,
} from "./activityStore";
import {
  buildTerminalAttentionCopy,
  buildTerminalCompletionCopy,
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  activeTerminalAttentionActivityKeys,
  activeThreadAttentionActivityKeys,
  collectCompletedThreadCandidates,
  collectCompletedTerminalCandidates,
  collectInputNeededThreadCandidates,
  collectTerminalAttentionCandidates,
  isNotificationRuntimeFreshTimestamp,
  shouldShowThreadNotificationToast,
  staleAttentionActivityKeys,
} from "./taskCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Browsers require secure contexts and a user gesture before asking for permission.
export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  if (!window.isSecureContext) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const current = readBrowserNotificationPermissionState();
  if (current === "unsupported" || current === "insecure" || current === "denied") {
    return current;
  }
  if (current === "granted") {
    return current;
  }
  return Notification.requestPermission();
}

function isWindowForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

interface ThreadNotificationCopy {
  title: string;
  body: string;
}

// Notification opens are generic thread activations, so they clear splitViewId
// instead of resurrecting a hidden split pairing.
function focusThread(threadId: Thread["id"], navigate: ReturnType<typeof useNavigate>): void {
  void navigate({
    to: "/$threadId",
    params: { threadId },
    search: (previous) => ({ ...previous, splitViewId: undefined }),
  });
}

async function showSystemThreadNotification(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  navigate: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  try {
    const { body, title } = copy;

    if (window.desktopBridge) {
      const supported = await window.desktopBridge.notifications.isSupported();
      if (!supported) {
        return false;
      }
      return window.desktopBridge.notifications.show({ title, body, silent: false, threadId });
    }

    if (readBrowserNotificationPermissionState() !== "granted") {
      return false;
    }

    const notification = new Notification(title, {
      body,
      tag: `thread-notification:${threadId}`,
    });
    notification.addEventListener("click", () => {
      window.focus();
      focusThread(threadId, navigate);
    });
    return true;
  } catch (error) {
    console.warn("Could not show system notification", error);
    return false;
  }
}

function publishThreadActivity(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  input: {
    dedupeKey: string;
    occurredAt?: string | undefined;
    source?: ActivitySource | undefined;
    status: ActivityStatus;
    tone: "success" | "warning";
  },
): void {
  const { body, title } = copy;
  activityManager.publish({
    dedupeKey: input.dedupeKey,
    source: input.source ?? "thread",
    status: input.status,
    tone: input.tone,
    title,
    description: body,
    occurredAt: input.occurredAt,
    destination: { type: "thread", threadId },
  });
}

function reconcilePersistedAttentionActivity(
  threads: readonly Thread[],
  terminalStateByThreadId: Parameters<typeof activeTerminalAttentionActivityKeys>[0],
): void {
  const activeKeys = new Set([
    ...activeThreadAttentionActivityKeys(threads),
    ...activeTerminalAttentionActivityKeys(terminalStateByThreadId),
  ]);
  for (const dedupeKey of staleAttentionActivityKeys(
    useActivityStore.getState().items,
    activeKeys,
  )) {
    activityManager.remove(dedupeKey);
  }
}

export function TaskCompletionNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeSearch = useDiffRouteSearch();
  const splitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));
  const threads = useStore(useRef(createAllThreadsSelector()).current);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const terminalStateByThreadId = useTerminalStateStore((store) => store.terminalStateByThreadId);
  const visibleThreadIds = useMemo(() => {
    return resolveVisibleToastThreadIds({ activeThreadId, splitView });
  }, [activeThreadId, splitView]);
  const previousThreadsRef = useRef<readonly Thread[]>([]);
  const previousTerminalStateRef = useRef(terminalStateByThreadId);
  const runtimeStartedAtMsRef = useRef(Date.now());
  const readyRef = useRef(false);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      const prefix = "notification-open-thread:";
      if (!action.startsWith(prefix)) {
        return;
      }
      const threadId = action.slice(prefix.length).trim();
      if (threadId.length === 0) {
        return;
      }
      focusThread(threadId as Thread["id"], navigate);
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!readyRef.current) {
      previousThreadsRef.current = threads;
      previousTerminalStateRef.current = terminalStateByThreadId;
      reconcilePersistedAttentionActivity(threads, terminalStateByThreadId);
      readyRef.current = true;
      return;
    }

    const completions = collectCompletedThreadCandidates(
      previousThreadsRef.current,
      threads,
    ).filter((candidate) =>
      isNotificationRuntimeFreshTimestamp(candidate.completedAt, runtimeStartedAtMsRef.current),
    );
    const terminalCompletions = collectCompletedTerminalCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    );
    const inputNeededCandidates = collectInputNeededThreadCandidates(
      previousThreadsRef.current,
      threads,
    ).filter((candidate) =>
      isNotificationRuntimeFreshTimestamp(candidate.createdAt, runtimeStartedAtMsRef.current),
    );
    const terminalAttentionCandidates = collectTerminalAttentionCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    );
    const previousAttentionKeys = new Set([
      ...activeThreadAttentionActivityKeys(previousThreadsRef.current),
      ...activeTerminalAttentionActivityKeys(previousTerminalStateRef.current),
    ]);
    const currentAttentionKeys = new Set([
      ...activeThreadAttentionActivityKeys(threads),
      ...activeTerminalAttentionActivityKeys(terminalStateByThreadId),
    ]);
    for (const key of previousAttentionKeys) {
      if (!currentAttentionKeys.has(key)) activityManager.remove(key);
    }
    previousThreadsRef.current = threads;
    previousTerminalStateRef.current = terminalStateByThreadId;

    if (
      completions.length === 0 &&
      inputNeededCandidates.length === 0 &&
      terminalCompletions.length === 0 &&
      terminalAttentionCandidates.length === 0
    ) {
      return;
    }

    const windowForeground = isWindowForeground();
    const shouldAttemptSystemNotification =
      settings.enableSystemTaskCompletionNotifications && !windowForeground;

    for (const completion of completions) {
      const copy = buildTaskCompletionCopy(completion);
      if (
        settings.enableTaskCompletionToasts &&
        (!windowForeground ||
          shouldShowThreadNotificationToast({
            threadId: completion.threadId,
            visibleThreadIds,
          }))
      ) {
        publishThreadActivity(copy, completion.threadId, {
          dedupeKey: `thread:${completion.threadId}:completed:${completion.completedAt}`,
          occurredAt: completion.completedAt,
          status: "recent",
          tone: "success",
        });
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, completion.threadId, navigate);
      }
    }

    for (const candidate of inputNeededCandidates) {
      const copy = buildInputNeededCopy(candidate);
      if (
        settings.enableTaskCompletionToasts &&
        (!windowForeground ||
          shouldShowThreadNotificationToast({
            threadId: candidate.threadId,
            visibleThreadIds,
          }))
      ) {
        publishThreadActivity(copy, candidate.threadId, {
          dedupeKey: `thread:${candidate.threadId}:attention:${candidate.requestId}`,
          occurredAt: candidate.createdAt,
          status: "needs_attention",
          tone: "warning",
        });
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate);
      }
    }

    for (const completion of terminalCompletions) {
      const copy = buildTerminalCompletionCopy(completion);
      if (
        settings.enableTaskCompletionToasts &&
        (!windowForeground ||
          shouldShowThreadNotificationToast({
            threadId: completion.threadId,
            visibleThreadIds,
          }))
      ) {
        publishThreadActivity(copy, completion.threadId, {
          dedupeKey: `terminal:${completion.threadId}:${completion.terminalId}:completed`,
          source: "terminal",
          status: "recent",
          tone: "success",
        });
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, completion.threadId, navigate);
      }
    }

    for (const candidate of terminalAttentionCandidates) {
      const copy = buildTerminalAttentionCopy(candidate);
      if (
        settings.enableTaskCompletionToasts &&
        (!windowForeground ||
          shouldShowThreadNotificationToast({
            threadId: candidate.threadId,
            visibleThreadIds,
          }))
      ) {
        publishThreadActivity(copy, candidate.threadId, {
          dedupeKey: `terminal:${candidate.threadId}:${candidate.terminalId}:attention`,
          source: "terminal",
          status: "needs_attention",
          tone: "warning",
        });
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate);
      }
    }
  }, [
    navigate,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    terminalStateByThreadId,
    threads,
    threadsHydrated,
    visibleThreadIds,
  ]);

  return null;
}

export function buildNotificationSettingsSupportText(
  permissionState: BrowserNotificationPermissionState,
): string {
  if (isElectron) {
    return "Desktop app notifications use your operating system notification center.";
  }
  switch (permissionState) {
    case "granted":
      return "Browser notifications are enabled for this app.";
    case "denied":
      return "Browser notifications are blocked. Re-enable them in your browser site settings.";
    case "insecure":
      return "Browser notifications need a secure context. Localhost works; plain HTTP does not.";
    case "unsupported":
      return "This browser does not support desktop notifications.";
    case "default":
      return "Allow browser notifications to get alerts when chats or terminal agents finish or need input in the background.";
  }
}
