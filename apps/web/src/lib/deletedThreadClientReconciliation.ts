// FILE: deletedThreadClientReconciliation.ts
// Purpose: Keeps thread-delete UI state responsive after the server accepts deletion.
// Layer: Web orchestration helper
// Exports: browser cleanup and local-state reconciliation for deleted threads

import type { NativeApi, ThreadBrowserState, ThreadId } from "@synara/contracts";

import { useBrowserStateStore } from "../browserStateStore";
import { useOptimisticUserMessageStore } from "../optimisticUserMessageStore";
import { useUserMessageEditDraftStore } from "../userMessageEditDraftStore";

type DeletedThreadBrowserCleanupApi = Pick<NativeApi, "browser" | "projects">;

interface DeletedThreadClientReconciliationInput {
  api: DeletedThreadBrowserCleanupApi;
  threadIds: ReadonlyArray<ThreadId>;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
}

interface DeletedThreadClientReconciliationSingleInput extends Omit<
  DeletedThreadClientReconciliationInput,
  "threadIds"
> {
  threadId: ThreadId;
}

export function reconcileDeletedThreadFromClient(
  input: DeletedThreadClientReconciliationSingleInput,
): Promise<void> {
  return reconcileDeletedThreadsFromClient({
    api: input.api,
    threadIds: [input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
  });
}

function previewUrlsFromState(state: ThreadBrowserState | null | undefined): readonly string[] {
  return (
    state?.tabs.flatMap((tab) =>
      tab.kind === "artifact" || tab.kind === "local-html" ? [tab.url] : [],
    ) ?? []
  );
}

export async function cleanupDeletedThreadBrowserState(
  api: DeletedThreadBrowserCleanupApi,
  threadId: ThreadId,
): Promise<void> {
  const browserStore = useBrowserStateStore.getState();
  const cachedState = browserStore.threadStatesByThreadId[threadId];
  const liveState = await api.browser.getState({ threadId }).catch(() => null);
  const previewUrls = new Set([
    ...previewUrlsFromState(cachedState),
    ...previewUrlsFromState(liveState),
  ]);

  // Close main-process ownership before worktree cleanup can remove watched
  // paths. This also covers offscreen threads with no mounted BrowserPanel.
  await api.browser.close({ threadId }).catch(() => undefined);
  await Promise.all(
    [...previewUrls].map((previewUrl) =>
      api.projects.revokeHtmlArtifactPreview({ previewUrl }).catch(() => ({ revoked: false })),
    ),
  );
  useBrowserStateStore.getState().removeThreadState(threadId);
}

export function removeDeletedThreadsFromClientState(
  threadIds: ReadonlyArray<ThreadId>,
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void,
): void {
  for (const threadId of new Set(threadIds)) {
    useOptimisticUserMessageStore.getState().clearThread(threadId);
    useUserMessageEditDraftStore.getState().clear(threadId);
    removeDeletedThreadFromClientState(threadId);
  }
}

// Delete reconciliation is intentionally local-only; shell snapshots/events still own
// authoritative refresh and can arrive stale while a delete is propagating.
export async function reconcileDeletedThreadsFromClient(
  input: DeletedThreadClientReconciliationInput,
): Promise<void> {
  const threadIds = [...new Set(input.threadIds)];
  if (threadIds.length === 0) {
    return;
  }

  for (const threadId of threadIds) {
    await cleanupDeletedThreadBrowserState(input.api, threadId);
  }
  removeDeletedThreadsFromClientState(threadIds, input.removeDeletedThreadFromClientState);
}
