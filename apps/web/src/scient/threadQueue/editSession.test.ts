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
} from "../../composerDraftStore";
import {
  beginQueueEdit,
  finishQueueEdit,
  flushQueueEdit,
  loadQueueEdits,
  useQueueEditSessions,
} from "./editSession";
import { controlThreadQueue } from "./client";
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
