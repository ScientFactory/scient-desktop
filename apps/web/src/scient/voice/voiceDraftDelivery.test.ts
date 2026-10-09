import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  composerTargetKey,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore.ts";
import { useQueueEditSessions } from "../threadQueue/editSession.ts";
import {
  appendVoiceTranscriptToStoredDraft,
  hasAsyncSendPreparation,
  deliverVoiceTranscriptToDraft,
  registerVoiceDraftEndpoint,
  reportVoiceDraftFailure,
  type VoiceDraftDeliveryDependencies,
  type VoiceDraftEndpoint,
  type VoiceDraftNotice,
  type VoiceDraftOrigin,
} from "./voiceDraftDelivery.ts";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const THREAD = ThreadId.make("thread-shared-id");

function origin(target: ComposerThreadTarget, title: string | null = "Thread A"): VoiceDraftOrigin {
  return { key: composerTargetKey(target), target, title, open: vi.fn() };
}

function harness() {
  const frames: Array<() => void> = [];
  const notices: VoiceDraftNotice[] = [];
  const stored: Array<{ target: ComposerThreadTarget; text: string }> = [];
  let storeAccepts = true;
  const dependencies: VoiceDraftDeliveryDependencies = {
    scheduleFrame: (callback) => frames.push(callback),
    appendToStoredDraft: (target, text) => {
      if (!storeAccepts) return false;
      stored.push({ target, text });
      return true;
    },
    notify: (notice) => notices.push(notice),
  };
  return {
    dependencies,
    frames,
    notices,
    stored,
    rejectStore: () => {
      storeAccepts = false;
    },
    runFrames: () => frames.splice(0).forEach((frame) => frame()),
  };
}

function endpoint(overrides: Partial<{ accepts: boolean; inserts: boolean }> = {}) {
  const state = { accepts: overrides.accepts ?? true, ready: true };
  const value = {
    acceptsDraftText: vi.fn(() => state.accepts),
    insert: vi.fn(() => overrides.inserts ?? true),
    canSubmit: vi.fn(() => state.ready),
    submit: vi.fn(),
  } satisfies VoiceDraftEndpoint;
  return { value, state };
}

describe("deliverVoiceTranscriptToDraft", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  const register = (key: string, value: VoiceDraftEndpoint) =>
    cleanups.push(registerVoiceDraftEndpoint(key, value));

  it("inserts through the origin's visible composer and submits in the next frame", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const composer = endpoint();
    register(composerTargetKey(target), composer.value);
    const run = harness();

    deliverVoiceTranscriptToDraft(origin(target), "hello", true, run.dependencies);
    expect(composer.value.insert).toHaveBeenCalledExactlyOnceWith("hello");
    expect(composer.value.submit).not.toHaveBeenCalled();
    run.runFrames();
    expect(composer.value.submit).toHaveBeenCalledOnce();
    expect(run.stored).toEqual([]);
    expect(run.notices).toEqual([]);
  });

  it("Insert never submits", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const composer = endpoint();
    register(composerTargetKey(target), composer.value);
    const run = harness();

    deliverVoiceTranscriptToDraft(origin(target), "hello", false, run.dependencies);
    run.runFrames();
    expect(composer.value.insert).toHaveBeenCalledOnce();
    expect(composer.value.submit).not.toHaveBeenCalled();
    expect(run.notices).toEqual([]);
  });

  it.each(["unmounted", "question"] as const)(
    "does not submit when the origin composer is %s by the scheduled frame",
    (change) => {
      const target = scopeThreadRef(LOCAL, THREAD);
      const composer = endpoint();
      const unregister = registerVoiceDraftEndpoint(composerTargetKey(target), composer.value);
      cleanups.push(unregister);
      const run = harness();
      const from = origin(target);

      deliverVoiceTranscriptToDraft(from, "hello", true, run.dependencies);
      if (change === "unmounted") unregister();
      else composer.state.accepts = false;
      run.runFrames();
      expect(composer.value.submit).not.toHaveBeenCalled();
      expect(run.notices).toEqual([{ kind: "not-sent", origin: from }]);
    },
  );

  it("does not submit, and says so, when the composer cannot send right now", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const composer = endpoint();
    register(composerTargetKey(target), composer.value);
    const run = harness();
    const from = origin(target);

    deliverVoiceTranscriptToDraft(from, "hello", true, run.dependencies);
    composer.state.ready = false;
    run.runFrames();
    expect(composer.value.insert).toHaveBeenCalledOnce();
    expect(composer.value.submit).not.toHaveBeenCalled();
    expect(run.notices).toEqual([{ kind: "not-sent", origin: from }]);
  });

  it("a remounted composer for the same draft does not inherit the scheduled submit", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const key = composerTargetKey(target);
    const first = endpoint();
    const unregister = registerVoiceDraftEndpoint(key, first.value);
    const run = harness();

    deliverVoiceTranscriptToDraft(origin(target), "hello", true, run.dependencies);
    unregister();
    const second = endpoint();
    register(key, second.value);
    run.runFrames();
    expect(first.value.submit).not.toHaveBeenCalled();
    expect(second.value.submit).not.toHaveBeenCalled();
    expect(run.notices.map((notice) => notice.kind)).toEqual(["not-sent"]);
  });

  it.each([false, true])(
    "saves to the stored draft and says so when the origin is not visible (send: %s)",
    (send) => {
      const target = scopeThreadRef(LOCAL, THREAD);
      const run = harness();
      const from = origin(target);

      deliverVoiceTranscriptToDraft(from, "hello", send, run.dependencies);
      expect(run.stored).toEqual([{ target, text: "hello" }]);
      expect(run.frames).toEqual([]);
      expect(run.notices).toEqual([{ kind: send ? "not-sent" : "added", origin: from }]);
    },
  );

  it("keeps ordinary dictation out of a question that now occupies the composer", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const composer = endpoint({ accepts: false });
    register(composerTargetKey(target), composer.value);
    const run = harness();

    deliverVoiceTranscriptToDraft(origin(target), "hello", true, run.dependencies);
    expect(composer.value.insert).not.toHaveBeenCalled();
    expect(composer.value.submit).not.toHaveBeenCalled();
    expect(run.stored).toEqual([{ target, text: "hello" }]);
    expect(run.notices.map((notice) => notice.kind)).toEqual(["not-sent"]);
  });

  it("never delivers to the same thread id in another environment", () => {
    const remote = scopeThreadRef(REMOTE, THREAD);
    const local = scopeThreadRef(LOCAL, THREAD);
    const remoteComposer = endpoint();
    register(composerTargetKey(remote), remoteComposer.value);
    const run = harness();

    deliverVoiceTranscriptToDraft(origin(local), "hello", true, run.dependencies);
    run.runFrames();
    expect(remoteComposer.value.insert).not.toHaveBeenCalled();
    expect(remoteComposer.value.submit).not.toHaveBeenCalled();
    expect(run.stored).toEqual([{ target: local, text: "hello" }]);
  });

  it("offers the transcript when its draft no longer exists", () => {
    const run = harness();
    run.rejectStore();
    deliverVoiceTranscriptToDraft(
      origin(DraftId.make("closed-draft")),
      "hello",
      true,
      run.dependencies,
    );
    expect(run.notices).toEqual([{ kind: "unavailable", text: "hello" }]);
  });

  it("shows a failure in the visible control, or as a notice when the origin is gone", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const from = origin(target);
    const shown = vi.fn();
    const notify = vi.fn();
    reportVoiceDraftFailure(from, "Engine failed", shown, notify);
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      kind: "failed",
      origin: from,
      message: "Engine failed",
    });
    expect(shown).not.toHaveBeenCalled();

    register(from.key, endpoint().value);
    reportVoiceDraftFailure(from, "Engine failed", shown, notify);
    expect(shown).toHaveBeenCalledExactlyOnceWith("Engine failed");
    expect(notify).toHaveBeenCalledOnce();
  });
});

describe("appendVoiceTranscriptToStoredDraft", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
  });

  it("appends after text typed while the dictation was processing", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    useComposerDraftStore.getState().setPrompt(target, "typed meanwhile");
    expect(appendVoiceTranscriptToStoredDraft(target, " dictated ")).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "typed meanwhile dictated",
    );
  });

  it("keeps environments apart for identical thread ids", () => {
    const local = scopeThreadRef(LOCAL, THREAD);
    const remote = scopeThreadRef(REMOTE, THREAD);
    useComposerDraftStore.getState().setPrompt(remote, "remote draft");
    appendVoiceTranscriptToStoredDraft(local, "local words");
    expect(useComposerDraftStore.getState().getComposerDraft(local)?.prompt).toBe("local words");
    expect(useComposerDraftStore.getState().getComposerDraft(remote)?.prompt).toBe("remote draft");
  });

  it("writes to an open new-thread draft and refuses a closed one", () => {
    const draftId = DraftId.make("draft-open");
    const projectRef = scopeProjectRef(LOCAL, ProjectId.make("project-1"));
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectRef, draftId, { threadId: ThreadId.make("reserved") });
    expect(appendVoiceTranscriptToStoredDraft(draftId, "first words")).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("first words");

    const closed = DraftId.make("draft-closed");
    expect(appendVoiceTranscriptToStoredDraft(closed, "lost words")).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(closed)).toBeNull();
  });
});

describe("hasAsyncSendPreparation", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    useQueueEditSessions.setState({ sessions: {} });
  });
  afterEach(() => useQueueEditSessions.setState({ sessions: {} }));

  it("is false for an ordinary draft", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    expect(hasAsyncSendPreparation(target)).toBe(false);
  });

  it("is true for an extracted queue draft or an open queue edit", () => {
    const target = scopeThreadRef(LOCAL, THREAD);
    const key = composerTargetKey(target);
    useComposerDraftStore.setState({
      draftsByThreadKey: {
        [key]: {
          ...useComposerDraftStore.getState().getComposerDraft(target),
          prompt: "extracted",
          extractedIntent: { intentId: "intent-1", journalKey: "journal-1" },
        } as never,
      },
    });
    expect(hasAsyncSendPreparation(target)).toBe(true);

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    expect(hasAsyncSendPreparation(target)).toBe(false);
    useQueueEditSessions.setState({ sessions: { [key]: {} as never } });
    expect(hasAsyncSendPreparation(target)).toBe(true);
  });
});
