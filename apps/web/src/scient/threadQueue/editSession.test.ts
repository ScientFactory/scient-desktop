import { readQueueEditJournal } from "./editJournal";
import "fake-indexeddb/auto";
import {
  EnvironmentId,
  ThreadId,
  ScientThreadQueueOperationError,
  type ScientThreadQueueItem,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  composerTargetKey,
  createEmptyThreadDraft,
  useComposerDraftStore,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import {
  beginQueueEdit,
  finishQueueEdit,
  flushQueueEdit,
  loadQueueEdits,
  useQueueEditSessions,
} from "./editSession";
import { controlThreadQueue } from "./client";
import {
  encodeQueueComposerSnapshot,
  assertQueueEditSelectionProvenance,
} from "./composerSnapshot";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import { stashQueueEdit, restoreQueueEditStash } from "./editSession";
import { usePromptStashStore } from "../../promptStashStore";
import {
  buildMessageContext,
  terminalContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
} from "../../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});
vi.mock("./client", () => ({ controlThreadQueue: vi.fn() }));
const target = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const other = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};
const item: ScientThreadQueueItem = {
  queueItemId: "qitem_A",
  threadId: target.threadId,
  text: "queued text",
  attachments: [],
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
beforeEach(async () => {
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, _options: unknown, callback: (lock: object) => Promise<void>) =>
        callback({}),
    },
  });
  await loadQueueEdits();
  for (const session of Object.values(useQueueEditSessions.getState().sessions))
    await finishQueueEdit(session);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  vi.mocked(controlThreadQueue).mockResolvedValue({ threadId: target.threadId, items: [] });
});

describe("queue edit handoff", () => {
  it("updates terminal chips on the hidden draft without registering a new project draft or touching the ordinary composer", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "ordinary");
    const contexts = [1, 2].map((n) => ({
      id: `ctx-${n}`,
      threadId: target.threadId,
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: n,
      lineEnd: n,
      text: `line ${n}`,
      createdAt: item.createdAt,
    }));
    await beginQueueEdit(target, {
      ...item,
      composerSnapshot: encodeQueueComposerSnapshot({
        ...createEmptyThreadDraft(),
        prompt: "Inspect",
        terminalContexts: contexts,
      }),
    });
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(store.getDraftThread(session.editTarget)).toBeNull();
    store.setTerminalContexts(session.editTarget, contexts.toReversed());
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(session.editTarget)
        ?.terminalContexts.map((context) => context.id),
    ).toEqual(["ctx-2", "ctx-1"]);
    await flushQueueEdit(session);
    const saved = (await readQueueEditJournal(session.journalKey))!;
    expect(saved.edited.contextThreadId).toBe(target.threadId);
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [composerTargetKey(session.editTarget)]: saved.edited,
      },
    }));
    store.setTerminalContexts(session.editTarget, []);
    await flushQueueEdit(session);
    expect((await readQueueEditJournal(session.journalKey))?.edited.terminalContexts).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("ordinary");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.terminalContexts).toEqual([]);
  });
  it("round-trips typed composer context, selection changes, journal and stash without promotion or duplication", async () => {
    const draft = {
      ...createEmptyThreadDraft(),
      prompt: "$requested inspect this",
      terminalContexts: [
        {
          id: "terminal-context",
          threadId: target.threadId,
          terminalId: "default",
          terminalLabel: "Terminal",
          lineStart: 1,
          lineEnd: 1,
          text: "$contextskill measured data",
          createdAt: item.createdAt,
        },
      ],
      previewAnnotations: [
        {
          id: "preview",
          pageUrl: "https://example.com",
          pageTitle: "Figure",
          comment: "$previewskill",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: item.createdAt,
        },
      ],
      reviewComments: [
        {
          id: "review",
          sectionId: "s",
          sectionTitle: "Review",
          filePath: "plot.py",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "$reviewskill",
          diff: "+ value = 1",
        },
      ],
    };
    draft.prompt = ensureInlineContextReferences(draft.prompt, [
      ...draft.terminalContexts.map(terminalContextReference),
      ...draft.previewAnnotations.map(previewAnnotationContextReference),
      ...draft.reviewComments.map(reviewCommentContextReference),
    ]);
    const materialize = (value: ComposerThreadDraftState) =>
      projectComposerContextForProvider({
        text: value.prompt,
        records: buildMessageContext(value)!.records,
      });
    const text = draft.prompt;
    const delivered = materialize(draft);
    expect(delivered).toContain("$contextskill measured data");
    expect(delivered).toContain("$previewskill");
    await beginQueueEdit(target, {
      ...item,
      text,
      selectedScientSkillNames: ["requested"],
      composerSnapshot: encodeQueueComposerSnapshot(draft),
    });
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    let edited = useComposerDraftStore.getState().getComposerDraft(session.editTarget)!;
    expect(edited.prompt).toBe(draft.prompt);
    expect(collectSelectedScientSkillNames(edited.prompt)).toEqual(["requested"]);
    expect(materialize({ ...draft, ...edited })).toBe(delivered);
    useComposerDraftStore
      .getState()
      .setPrompt(session.editTarget, text.replace("$requested", "$replacement"));
    await flushQueueEdit(session);
    const saved = (await readQueueEditJournal(session.journalKey))!;
    expect(saved.composerSeparated).toBe(true);
    expect(collectSelectedScientSkillNames(saved.edited.prompt)).toEqual(["replacement"]);
    expect(saved.edited.terminalContexts).toEqual(draft.terminalContexts);
    expect(saved.edited.previewAnnotations).toEqual(draft.previewAnnotations);
    await stashQueueEdit(session);
    const entry = usePromptStashStore
      .getState()
      .entries.find((entry) => entry.queueEditKey === session.journalKey)!;
    expect(await restoreQueueEditStash(entry, other, other.environmentId)).toBe(true);
    edited = useComposerDraftStore.getState().getComposerDraft(other)!;
    expect(collectSelectedScientSkillNames(edited.prompt)).toEqual(["replacement"]);
    expect(edited.prompt).toBe(text.replace("$requested", "$replacement"));
    expect(materialize({ ...draft, ...edited })).toBe(
      delivered.replace("$requested", "$replacement"),
    );
    expect(() =>
      assertQueueEditSelectionProvenance(saved.composerSeparated, edited.prompt),
    ).not.toThrow();
  });

  it("keeps legacy context-bearing Skill edits and malformed snapshots intact instead of guessing authorship", async () => {
    vi.mocked(controlThreadQueue).mockClear();
    await expect(
      beginQueueEdit(target, {
        ...item,
        text: "request\n<terminal_context>\n$contextskill\n</terminal_context>",
      }),
    ).rejects.toThrow("older queue edit");
    await expect(
      beginQueueEdit(target, { ...item, composerSnapshot: "{broken" }),
    ).rejects.toThrow();
    expect(controlThreadQueue).not.toHaveBeenCalled();
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
    expect(() => assertQueueEditSelectionProvenance(undefined, "$contextskill")).toThrow(
      "saved edit is preserved",
    );
  });
  it("keeps the full ordinary draft and its file bytes while editing in another internal identity", async () => {
    const ordinary = {
      ...createEmptyThreadDraft(),
      prompt: "ordinary draft",
      files: [
        {
          type: "file" as const,
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: new File(["hello"], "notes.txt", { type: "text/plain" }),
        },
      ],
    };
    useComposerDraftStore.setState({
      draftsByThreadKey: { [composerTargetKey(target)]: ordinary },
    });
    await beginQueueEdit(target, item);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(ordinary);
    expect(useComposerDraftStore.getState().getComposerDraft(session.editTarget)?.prompt).toBe(
      "queued text",
    );
    await flushQueueEdit(session);
    const saved = await readQueueEditJournal(session.journalKey);
    expect(saved?.ordinary.prompt).toBe("ordinary draft");
    expect(await saved?.ordinary.files[0]?.file?.text()).toBe("hello");
    expect(saved?.edited.prompt).toBe("queued text");
    await finishQueueEdit(session);
    expect(await readQueueEditJournal(session.journalKey)).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "ordinary draft",
    );
  });
  it("does not overwrite a different thread when the edit response arrives after navigation", async () => {
    let resolve!: (value: { threadId: typeof target.threadId; items: [] }) => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    vi.mocked(controlThreadQueue).mockImplementationOnce(() => {
      enteredResolve();
      return new Promise((done) => {
        resolve = done;
      });
    });
    useComposerDraftStore.getState().setPrompt(other, "other thread draft");
    const editing = beginQueueEdit(target, item);
    await entered;
    useComposerDraftStore.getState().setPrompt(other, "continued typing elsewhere");
    resolve({ threadId: target.threadId, items: [] });
    await editing;
    expect(useComposerDraftStore.getState().getComposerDraft(other)?.prompt).toBe(
      "continued typing elsewhere",
    );
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(other)]).toBeUndefined();
  });
  it("retains both drafts and the same withdrawal token when the server response is lost", async () => {
    useComposerDraftStore.getState().setPrompt(target, "hidden ordinary draft");
    vi.mocked(controlThreadQueue).mockRejectedValueOnce(new Error("connection interrupted"));
    await expect(beginQueueEdit(target, item)).rejects.toThrow("connection interrupted");
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(session.editToken).toBe(vi.mocked(controlThreadQueue).mock.lastCall?.[1].editToken);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "hidden ordinary draft",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(session.editTarget)?.prompt).toBe(
      "queued text",
    );
  });
  it("keeps late attachment and text updates attached to the original hidden draft", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    await beginQueueEdit(target, item);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    useComposerDraftStore.getState().setPrompt(target, "ordinary with late transcript");
    await flushQueueEdit(session);
    expect(useComposerDraftStore.getState().getComposerDraft(session.editTarget)?.prompt).toBe(
      "queued text",
    );
    await finishQueueEdit(session);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "ordinary with late transcript",
    );
  });
  it("keeps the ordinary composer when a withdrawal definitely loses to delivery", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    vi.mocked(controlThreadQueue).mockRejectedValueOnce(
      new ScientThreadQueueOperationError({ message: "Already started" }),
    );
    await expect(beginQueueEdit(target, item)).rejects.toThrow("Already started");
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("ordinary");
  });
  it("preserves the ordinary draft and queue when browser locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    vi.mocked(controlThreadQueue).mockClear();
    useComposerDraftStore.getState().setPrompt(target, "ordinary draft");
    await expect(beginQueueEdit(target, item)).rejects.toThrow("Use HTTPS or localhost");
    expect(controlThreadQueue).not.toHaveBeenCalled();
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "ordinary draft",
    );
  });
  it("does not withdraw a message when another window owns this thread's edit lease", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: (_key: string, _options: unknown, callback: (lock: null) => Promise<void>) =>
          callback(null),
      },
    });
    vi.mocked(controlThreadQueue).mockClear();
    await expect(beginQueueEdit(target, item)).rejects.toThrow("another window");
    expect(controlThreadQueue).not.toHaveBeenCalled();
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
  });
});
