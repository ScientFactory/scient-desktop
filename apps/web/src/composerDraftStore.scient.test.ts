import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  DraftId,
  partializeComposerDraftStoreState,
  queuedRunEditDraftId,
  useComposerDraftStore,
} from "./composerDraftStore";
import { retargetDraftWorkspace } from "./lib/retargetDraftWorkspace";

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

describe("workspace choices in saved drafts", () => {
  const projectId = ProjectId.make("project-saved-workspace");
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);
  const worktreeKey = threadKeyFor(ThreadId.make("saved-worktree-choice"), TEST_ENVIRONMENT_ID);
  const localKey = threadKeyFor(ThreadId.make("saved-local-choice"), TEST_ENVIRONMENT_ID);
  const corruptKey = threadKeyFor(ThreadId.make("saved-corrupt-draft"), TEST_ENVIRONMENT_ID);
  const emptyPathKey = threadKeyFor(ThreadId.make("saved-empty-path-draft"), TEST_ENVIRONMENT_ID);
  const savedDraftThread = (threadId: string, envMode: string) => ({
    threadId,
    environmentId: TEST_ENVIRONMENT_ID,
    projectId,
    logicalProjectKey: scopedProjectKey(projectRef),
    createdAt: "2026-08-01T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    envMode,
    startFromOrigin: envMode === "worktree",
    promotedTo: null,
  });
  const restore = (version: number, state: unknown) => {
    const { migrate, merge } = useComposerDraftStore.persist.getOptions();
    const migrated = version === COMPOSER_DRAFT_STORAGE_VERSION ? state : migrate!(state, version);
    return merge!(migrated, useComposerDraftStore.getInitialState());
  };

  afterEach(resetComposerDraftStore);

  it("pins a worktree or local choice saved before workspace choices were recorded", async () => {
    // The shape the previous schema wrote: no workspaceExplicit field on any draft.
    const savedState = JSON.parse(
      JSON.stringify({
        version: 9,
        state: {
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {
            [worktreeKey]: savedDraftThread("saved-worktree-choice", "worktree"),
            [localKey]: savedDraftThread("saved-local-choice", "local"),
            [corruptKey]: {
              ...savedDraftThread("saved-corrupt-draft", "banana"),
              worktreePath: 42,
            },
            [emptyPathKey]: {
              ...savedDraftThread("saved-empty-path-draft", "local"),
              worktreePath: "",
            },
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        },
      }),
    ) as { version: number; state: unknown };

    const hydrated = restore(savedState.version, savedState.state);
    useComposerDraftStore.setState(hydrated);

    expect(hydrated.draftThreadsByThreadKey[worktreeKey]).toMatchObject({
      envMode: "worktree",
      startFromOrigin: true,
      workspaceExplicit: true,
    });
    expect(hydrated.draftThreadsByThreadKey[localKey]).toMatchObject({
      envMode: "local",
      startFromOrigin: false,
      workspaceExplicit: true,
    });
    expect(hydrated.draftThreadsByThreadKey[corruptKey]).not.toHaveProperty("workspaceExplicit");
    expect(hydrated.draftThreadsByThreadKey[emptyPathKey]).not.toHaveProperty("workspaceExplicit");
    const session = useComposerDraftStore.getState().getDraftSession(DraftId.make(worktreeKey));
    expect(await retargetDraftWorkspace(session!, projectRef, AbortSignal.timeout(1_000))).toEqual(
      {},
    );
  });

  it.each([COMPOSER_DRAFT_STORAGE_VERSION, COMPOSER_DRAFT_STORAGE_VERSION + 1])(
    "keeps stored flags and leaves unflagged drafts inherited on schema v%i",
    (version) => {
      const hydrated = restore(version, {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {
          [worktreeKey]: savedDraftThread("saved-worktree-choice", "worktree"),
          [localKey]: {
            ...savedDraftThread("saved-local-choice", "local"),
            workspaceExplicit: true,
          },
          [emptyPathKey]: {
            ...savedDraftThread("saved-empty-path-draft", "local"),
            workspaceExplicit: false,
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      });

      expect(hydrated.draftThreadsByThreadKey[worktreeKey]).not.toHaveProperty("workspaceExplicit");
      expect(hydrated.draftThreadsByThreadKey[localKey]).toMatchObject({ workspaceExplicit: true });
      expect(hydrated.draftThreadsByThreadKey[emptyPathKey]).not.toHaveProperty(
        "workspaceExplicit",
      );
    },
  );
});
