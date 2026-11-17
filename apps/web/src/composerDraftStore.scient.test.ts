import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  partializeComposerDraftStoreState,
  queuedRunEditDraftId,
  useComposerDraftStore,
} from "./composerDraftStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function threadKeyFor(threadId: ThreadId, environmentId: EnvironmentId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId) {
  return useComposerDraftStore.getState().draftsByThreadKey[threadKeyFor(threadId, environmentId)];
}

describe("composerDraftStore Antigravity selections", () => {
  beforeEach(resetComposerDraftStore);
  it("persists Antigravity reasoning changes as native model selections across reload and new drafts", async () => {
    vi.useFakeTimers();
    try {
      const instanceId = ProviderInstanceId.make("google_work");
      const threadId = ThreadId.make("antigravity-reasoning");
      const target = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
      const selection = createModelSelection(instanceId, "gemini-3.8-flash-low");
      useComposerDraftStore.getState().setModelSelection(target, selection, { explicit: true });
      useComposerDraftStore.getState().setStickyModelSelection(selection);
      const options = useComposerDraftStore.persist.getOptions();
      await vi.advanceTimersByTimeAsync(300);
      const saved = await options.storage!.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      expect(saved).not.toBeNull();
      useComposerDraftStore.setState(
        options.merge!(saved!.state, useComposerDraftStore.getState()),
      );
      expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[instanceId]).toEqual(
        selection,
      );
      const newThreadId = ThreadId.make("antigravity-next-draft");
      useComposerDraftStore
        .getState()
        .applyStickyState(scopeThreadRef(TEST_ENVIRONMENT_ID, newThreadId));
      expect(
        draftFor(newThreadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[instanceId],
      ).toEqual(selection);
    } finally {
      await useComposerDraftStore.persist.clearStorage();
      vi.useRealTimers();
    }
  });
  afterEach(resetComposerDraftStore);
});

describe("drafts saved by the retired queue-edit extraction", () => {
  const threadId = ThreadId.make("extracted-intent-thread");
  it("hydrate as ordinary drafts that keep their text and images", () => {
    const key = threadKeyFor(threadId, TEST_ENVIRONMENT_ID);
    const image = {
      id: "image-1",
      name: "kept.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAAA",
    };
    const hydrated = useComposerDraftStore.persist.getOptions().merge!(
      {
        draftsByThreadKey: {
          [key]: {
            prompt: "keep",
            attachments: [image],
            extractedIntent: {
              intentId: "11111111-1111-4111-8111-111111111111",
              journalKey: "journal",
            },
            imageSelection: [],
          },
        },
      },
      useComposerDraftStore.getInitialState(),
    );
    const draft = hydrated.draftsByThreadKey[key];
    expect(draft?.prompt).toBe("keep");
    expect(draft?.images.map(({ id }) => id)).toEqual(["image-1"]);
    expect(draft && "extractedIntent" in draft).toBe(false);
    expect(draft && "pendingImageSelection" in draft).toBe(false);
  });
});

describe("queued-message edit drafts", () => {
  it("stay in their window and are never stored", () => {
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("queued-edit-thread"));
    const editTarget = queuedRunEditDraftId(threadRef, "run-1");
    useComposerDraftStore.getState().setPrompt(threadRef, "ordinary draft");
    useComposerDraftStore.getState().setPrompt(editTarget, "edited queued message");
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(Object.keys(persisted.draftsByThreadKey)).toEqual([scopedThreadKey(threadRef)]);
    expect(useComposerDraftStore.getState().getComposerDraft(editTarget)?.prompt).toBe(
      "edited queued message",
    );
    resetComposerDraftStore();
  });
});
