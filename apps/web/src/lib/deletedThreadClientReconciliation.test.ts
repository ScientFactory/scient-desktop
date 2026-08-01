// FILE: deletedThreadClientReconciliation.test.ts
// Purpose: Verifies immediate thread-delete UI reconciliation without rendering callers.
// Layer: Web orchestration helper tests

import type { NativeApi, ThreadBrowserState } from "@synara/contracts";
import { MessageId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserStateStore } from "../browserStateStore";
import { useUserMessageEditDraftStore } from "../userMessageEditDraftStore";
import { createMemoryStorage } from "./storage";

import {
  reconcileDeletedThreadFromClient,
  reconcileDeletedThreadsFromClient,
} from "./deletedThreadClientReconciliation";

const originalLocalStorage = globalThis.localStorage;

function browserState(threadId: ThreadId, previewUrl?: string): ThreadBrowserState {
  return {
    threadId,
    version: 1,
    open: true,
    activeTabId: previewUrl ? "preview-tab" : null,
    tabs: previewUrl
      ? [
          {
            id: "preview-tab",
            kind: "local-html",
            url: previewUrl,
            displayUrl: "/workspace/report.html",
            title: "Report",
            status: "live",
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            faviconUrl: null,
            lastCommittedUrl: previewUrl,
            lastError: null,
          },
        ]
      : [],
    lastError: null,
  };
}

function cleanupApi(options: {
  getState: (input: { threadId: ThreadId }) => Promise<ThreadBrowserState>;
}) {
  return {
    browser: {
      getState: vi.fn(options.getState),
      close: vi.fn(async ({ threadId }: { threadId: ThreadId }) => browserState(threadId)),
    },
    projects: {
      revokeHtmlArtifactPreview: vi.fn(async () => ({ revoked: true })),
    },
  } as unknown as Pick<NativeApi, "browser" | "projects">;
}

beforeEach(() => {
  globalThis.localStorage = createMemoryStorage() as Storage;
});

afterEach(() => {
  useBrowserStateStore.setState({ threadStatesByThreadId: {}, recentHistoryByThreadId: {} });
  useUserMessageEditDraftStore.getState().clearAll();
  globalThis.localStorage = originalLocalStorage;
});

describe("reconcileDeletedThreadFromClient", () => {
  it("removes the local row without applying a shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete");
    const removeDeletedThreadFromClientState = vi.fn();
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:5000/";
    const api = cleanupApi({ getState: async () => browserState(threadId, previewUrl) });

    await reconcileDeletedThreadFromClient({
      api,
      threadId,
      removeDeletedThreadFromClientState,
    });

    expect(api.browser.close).toHaveBeenCalledWith({ threadId });
    expect(api.projects.revokeHtmlArtifactPreview).toHaveBeenCalledWith({ previewUrl });
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
    expect(vi.mocked(api.browser.close).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(api.projects.revokeHtmlArtifactPreview).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(api.projects.revokeHtmlArtifactPreview).mock.invocationCallOrder[0],
    ).toBeLessThan(removeDeletedThreadFromClientState.mock.invocationCallOrder[0]!);
  });

  it("cleans an offscreen preview from cached state when live hydration fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete-offscreen");
    const previewUrl = "http://g-22345678-1234-4123-8123-123456789abc.preview.localhost:5000/";
    useBrowserStateStore.getState().upsertThreadState(browserState(threadId, previewUrl));
    const api = cleanupApi({ getState: async () => Promise.reject(new Error("offline")) });

    await reconcileDeletedThreadFromClient({
      api,
      threadId,
      removeDeletedThreadFromClientState: vi.fn(),
    });

    expect(api.browser.close).toHaveBeenCalledWith({ threadId });
    expect(api.projects.revokeHtmlArtifactPreview).toHaveBeenCalledWith({ previewUrl });
    expect(useBrowserStateStore.getState().threadStatesByThreadId[threadId]).toBeUndefined();
  });

  it("removes history-only browser cache for a deleted thread", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete-history-only");
    useBrowserStateStore.setState({
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {
        [threadId]: [{ url: "https://example.com/", title: "Example", tabId: "history-tab" }],
      },
    });
    const api = cleanupApi({ getState: async () => browserState(threadId) });

    await reconcileDeletedThreadFromClient({
      api,
      threadId,
      removeDeletedThreadFromClientState: vi.fn(),
    });

    expect(useBrowserStateStore.getState().recentHistoryByThreadId[threadId]).toBeUndefined();
  });
});

describe("reconcileDeletedThreadsFromClient", () => {
  it("deduplicates bulk thread removals without applying a shell snapshot", async () => {
    const threadA = ThreadId.makeUnsafe("thread-delete-a");
    const threadB = ThreadId.makeUnsafe("thread-delete-b");
    const removeDeletedThreadFromClientState = vi.fn();
    const api = cleanupApi({ getState: async ({ threadId }) => browserState(threadId) });
    useUserMessageEditDraftStore.getState().begin(threadA, {
      messageId: MessageId.makeUnsafe("message-delete-draft"),
      draftText: "replacement text",
      originalText: "original text",
      originalRevision: "2026-08-01T08:00:00.000Z",
    });

    await reconcileDeletedThreadsFromClient({
      api,
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
    });

    expect(api.browser.close).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.browser.close).mock.calls.map(([input]) => input.threadId)).toEqual([
      threadA,
      threadB,
    ]);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA], [threadB]]);
    expect(useUserMessageEditDraftStore.getState().draftsByThreadId[threadA]).toBeUndefined();
  });
});
