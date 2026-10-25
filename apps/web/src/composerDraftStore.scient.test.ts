import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  partializeComposerDraftStoreState,
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

describe("extracted draft intent persistence", () => {
  const threadId = ThreadId.make("extracted-intent-thread");
  it("keeps the stable marker through persistence/hydration and ordinary authoring clears it explicitly", () => {
    const key = threadKeyFor(threadId, TEST_ENVIRONMENT_ID);
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId), "captured");
    const marker = {
      intentId: "11111111-1111-4111-8111-111111111111",
      journalKey: "copied-journal",
    };
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: { ...state.draftsByThreadKey[key]!, extractedIntent: marker },
      },
    }));
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const hydrated = useComposerDraftStore.persist.getOptions().merge!(
      persisted,
      useComposerDraftStore.getInitialState(),
    );
    expect(hydrated.draftsByThreadKey[key]?.extractedIntent).toEqual(marker);
    useComposerDraftStore.setState(hydrated);
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId), "late typed");
    expect(useComposerDraftStore.getState().draftsByThreadKey[key]?.extractedIntent).toEqual(
      marker,
    );
    useComposerDraftStore
      .getState()
      .clearComposerContent(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId), "captured");
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[key]?.extractedIntent,
    ).toBeUndefined();
  });
  it("does not turn a malformed present marker into an unmarked ordinary draft", () => {
    const key = threadKeyFor(threadId, TEST_ENVIRONMENT_ID);
    const hydrated = useComposerDraftStore.persist.getOptions().merge!(
      {
        draftsByThreadKey: {
          [key]: { prompt: "keep", attachments: [], extractedIntent: { intentId: "bad" } },
        },
      },
      useComposerDraftStore.getInitialState(),
    );
    expect(hydrated.draftsByThreadKey[key]?.prompt).toBe("keep");
    expect(hydrated.draftsByThreadKey[key]?.extractedIntent).toEqual({ invalid: true });
  });
});
