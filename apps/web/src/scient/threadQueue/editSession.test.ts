import "fake-indexeddb/auto";
import {
  CommandId,
  OrchestrationV2DispatchCommandError,
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  RunId,
  MessageId,
  PlanId,
  ScientThreadQueueOperationError,
  type ScientThreadQueueItem,
  type ScientThreadQueueSnapshot,
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
  stashRecoveredDraft,
  restoreQueueEditStash,
  useQueueEditSessions,
} from "./editSession";
import { controlThreadQueue, extractNativeQueuedRun, readQueuedAttachmentFile } from "./client";
import { nativeQueueExtractionError } from "./nativeQueueExtractionError";
import { encodeQueueComposerSnapshot } from "./composerSnapshot";
import * as editJournal from "./editJournal";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import { usePromptStashStore } from "../../promptStashStore";
import { buildMessageContext, terminalContextReference } from "../../lib/composerContextRecords";
import * as DateTime from "effect/DateTime";
import { nativeQueueEditItem } from "./nativeQueueEditItem";
import {
  ensureInlineContextReferences,
  toKindScopedComposerContextId,
  formatInlineContextReference,
} from "../../lib/composerContextReferences";
import {
  projectComposerContextForProvider,
  collectComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const { readQueueEditJournal } = editJournal;
const originalStashEntry = usePromptStashStore.getState().stashEntry;
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
vi.mock("./client", () => ({
  controlThreadQueue: vi.fn(),
  extractNativeQueuedRun: vi.fn(),
  readQueuedAttachmentFile: vi.fn(),
}));
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
  vi.restoreAllMocks();
  usePromptStashStore.setState({ stashEntry: originalStashEntry });
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
  usePromptStashStore.setState({ entries: [] });
  useQueueEditSessions.setState({ error: null });
  vi.mocked(controlThreadQueue).mockReset();
  vi.mocked(controlThreadQueue).mockImplementation(async (_environmentId, request) => ({
    ...request,
    items: [],
    revision: 1,
  }));
  vi.mocked(readQueuedAttachmentFile).mockReset();
  vi.mocked(extractNativeQueuedRun).mockReset();
});
describe("queue extraction into an ordinary draft", () => {
  it.each([
    {
      label: "imported captured policy",
      native: false,
      legacy: true,
      expectedRuntime: "approval-required",
      expectedInteraction: "plan",
      expectedPlan: "legacy-plan",
    },
    {
      label: "native policy takes precedence",
      native: true,
      legacy: true,
      expectedRuntime: "full-access",
      expectedInteraction: "default",
      expectedPlan: "native-plan",
    },
    {
      label: "older native run uses thread defaults",
      native: false,
      legacy: false,
      expectedRuntime: "full-access",
      expectedInteraction: "default",
      expectedPlan: undefined,
    },
  ] as const)(
    "journals and recovers $label when native extraction transfers the draft",
    async (scenario) => {
      const run = {
        id: RunId.make("imported-native-run"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("captured-provider"),
          model: "captured-model",
        },
        ...(scenario.native
          ? {
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              sourcePlanRef: { threadId: target.threadId, planId: PlanId.make("native-plan") },
            }
          : {}),
        ...(scenario.legacy
          ? {
              legacyQueue: {
                queueItemId: "retained-legacy-item",
                runtimeMode: "approval-required" as const,
                interactionMode: "plan" as const,
                titleSeed: "Captured title",
                sourceProposedPlan: {
                  threadId: target.threadId,
                  planId: PlanId.make("legacy-plan"),
                },
              },
            }
          : {}),
      };
      const message = {
        id: MessageId.make("captured-message"),
        text: "captured prompt",
        attachments: [],
        createdAt: DateTime.makeUnsafe(item.createdAt),
        updatedAt: DateTime.makeUnsafe(item.updatedAt),
        selectedScientSkillNames: [],
      };
      const queued = nativeQueueEditItem(run, message, {
        id: target.threadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      useComposerDraftStore.getState().setPrompt(target, "ordinary draft survives in stash");
      vi.mocked(extractNativeQueuedRun).mockResolvedValueOnce({ sequence: 1 });
      const nativeRun = {
        runId: run.id,
        messageId: message.id,
        expectedUpdatedAt: queued.updatedAt,
      };
      await beginQueueEdit(target, queued, nativeRun);
      const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
      const journal = (await readQueueEditJournal(session.journalKey))!;
      expect(vi.mocked(extractNativeQueuedRun)).toHaveBeenCalledWith(target.environmentId, {
        threadId: target.threadId,
        runId: run.id,
        expectedUpdatedAt: queued.updatedAt,
        editToken: session.editToken,
      });
      expect(journal.transferred).toBe(true);
      expect(journal.extractedItem?.sourceProposedPlan?.planId).toBe(scenario.expectedPlan);
      expect(journal.extractedItem?.selectedScientSkillNames).toEqual([]);
      expect(journal.extractedItem?.context).toBeUndefined();
      expect(journal.extractedItem?.titleSeed).toBe(scenario.legacy ? "Captured title" : undefined);
      expect(journal.ordinary.prompt).toBe("ordinary draft survives in stash");
      expect(journal.edited.runtimeMode).toBe(scenario.expectedRuntime);
      expect(journal.edited.interactionMode).toBe(scenario.expectedInteraction);
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
        scenario.expectedRuntime,
      );
      await stashRecoveredDraft(session);
      const entry = usePromptStashStore
        .getState()
        .entries.find((candidate) => candidate.queueEditSide === "edited")!;
      await restoreQueueEditStash(entry, other, other.environmentId);
      const recoveredSession = useQueueEditSessions.getState().sessions[composerTargetKey(other)]!;
      const recoveredJournal = (await readQueueEditJournal(recoveredSession.journalKey))!;
      expect(recoveredJournal.extractedItem?.sourceProposedPlan?.planId).toBe(
        scenario.expectedPlan,
      );
      expect(useComposerDraftStore.getState().getComposerDraft(other)?.runtimeMode).toBe(
        scenario.expectedRuntime,
      );
      expect(useComposerDraftStore.getState().getComposerDraft(other)?.interactionMode).toBe(
        scenario.expectedInteraction,
      );
    },
  );
  it("uses journaled bytes after extraction even when another attachment download would fail", async () => {
    const attachment = {
      type: "file" as const,
      id: "owned-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const queued = { ...item, attachments: [attachment] };
    vi.mocked(readQueuedAttachmentFile)
      .mockResolvedValueOnce(new File(["hello"], "notes.txt", { type: "text/plain" }))
      .mockRejectedValue(new Error("download unavailable"));
    vi.mocked(controlThreadQueue).mockImplementation(async (_environment, request) => ({
      ...request,
      items: [],
      revision: 1,
    }));
    await beginQueueEdit(target, queued);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(
      await useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.file?.text(),
    ).toBe("hello");
    expect(
      await (await readQueueEditJournal(session.journalKey))?.edited.files[0]?.file?.text(),
    ).toBe("hello");
    expect(session.transferred).toBe(true);
  });
  it("captures typing during the final durable handoff before replacing the ordinary draft", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const write = editJournal.writeQueueEditJournal;
    let held = false;
    vi.spyOn(editJournal, "writeQueueEditJournal").mockImplementation(async (value) => {
      if (typeof value !== "string" && value.transferred && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      await write(value);
    });
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    const editing = beginQueueEdit(target, item);
    await entered.promise;
    useComposerDraftStore.getState().setPrompt(target, "typed during journal write");
    release.resolve();
    await editing;
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect((await readQueueEditJournal(session.journalKey))?.ordinary.prompt).toBe(
      "typed during journal write",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
  });
  it("does not replace the prior draft or accept an in-memory-only stash on repeated recovery", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    usePromptStashStore.setState({
      stashEntry: (entry) => {
        usePromptStashStore.setState({
          entries: [entry, ...usePromptStashStore.getState().entries],
        });
        return { written: true, durable: false, evicted: null };
      },
    });
    await expect(beginQueueEdit(target, item)).rejects.toThrow("safely stashed");
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    await expect(flushQueueEdit(session)).rejects.toThrow("safely stashed");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("ordinary");
    expect(usePromptStashStore.getState().entries).toEqual([]);
    expect((await readQueueEditJournal(session.journalKey))?.stashed).not.toBe(true);
  });
  it("keeps the recovery journal discoverable when finishing cannot persist its stash", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    await beginQueueEdit(target, item);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    usePromptStashStore.setState({
      stashEntry: () => ({ written: false, durable: false, evicted: null }),
    });
    await expect(finishQueueEdit(session)).rejects.toThrow("safely stashed");
    expect((await readQueueEditJournal(session.journalKey))?.stashed).not.toBe(true);
    expect(useQueueEditSessions.getState().sessions[session.key]?.journalKey).toBe(
      session.journalKey,
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
  });
  it("replaces the ordinary target and keeps its complete previous draft in a recoverable stash", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const ordinary = {
      ...createEmptyThreadDraft(),
      prompt: "$ordinary original",
      runtimeMode: "approval-required" as const,
      files: [
        {
          type: "file" as const,
          id: "notes",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ],
    };
    useComposerDraftStore.setState({
      draftsByThreadKey: { [composerTargetKey(target)]: ordinary },
    });
    await beginQueueEdit(target, item);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(session.transferred).toBe(true);
    expect(session.editTarget).toEqual(target);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
    const entry = usePromptStashStore
      .getState()
      .entries.find((entry) => entry.queueEditSide === "ordinary")!;
    expect(entry.queueEditKey).toBe(session.journalKey);
    const journal = (await readQueueEditJournal(session.journalKey))!;
    expect(await journal.ordinary.files[0]?.file?.text()).toBe("hello");
    await finishQueueEdit(session);
    expect((await readQueueEditJournal(session.journalKey))?.stashed).toBe(true);
    await restoreQueueEditStash(entry, other, other.environmentId);
    const recovered = useComposerDraftStore.getState().getComposerDraft(other)!;
    expect(recovered.prompt).toBe("$ordinary original");
    expect(recovered.runtimeMode).toBe("approval-required");
    expect(await recovered.files[0]?.file?.text()).toBe("hello");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
    expect(await readQueueEditJournal(session.journalKey)).toBeUndefined();
    expect(
      usePromptStashStore.getState().entries.some((candidate) => candidate.id === entry.id),
    ).toBe(false);
  });
  it("preserves attachments, model, mode, context and authored skills without promoting skills inside context", async () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex-test"),
      model: "test-model",
    };
    const terminalContexts = [
      {
        id: "ctx-1",
        threadId: target.threadId,
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        text: "$contextskill data",
        createdAt: item.createdAt,
      },
    ];
    const image = {
      type: "image" as const,
      id: "image",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const attachment = {
      type: "file" as const,
      id: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const queued = {
      ...item,
      modelSelection,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
      attachments: [image, attachment],
      composerSnapshot: encodeQueueComposerSnapshot({
        ...createEmptyThreadDraft(),
        prompt: ensureInlineContextReferences(
          "$requested inspect",
          terminalContexts.map(terminalContextReference),
        ),
        terminalContexts,
      }),
    };
    vi.mocked(readQueuedAttachmentFile).mockImplementation(
      async (_environmentId, value) =>
        new File([value.type === "image" ? "plot" : "hello"], value.name, { type: value.mimeType }),
    );
    vi.mocked(controlThreadQueue).mockImplementation(async (_environmentId, request) => ({
      ...request,
      items: [],
      revision: 1,
    }));
    await beginQueueEdit(target, queued);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.modelSelectionByProvider[modelSelection.instanceId]).toEqual(modelSelection);
    expect(draft.activeProvider).toBe(modelSelection.instanceId);
    expect(draft.runtimeMode).toBe("approval-required");
    expect(draft.interactionMode).toBe("plan");
    expect(draft.terminalContexts).toEqual(terminalContexts);
    expect(collectSelectedScientSkillNames(draft.prompt)).toEqual(["requested"]);
    expect(await draft.images[0]?.file.text()).toBe("plot");
    expect(await draft.files[0]?.file?.text()).toBe("hello");
    useComposerDraftStore
      .getState()
      .setPrompt(target, draft.prompt.replace("$requested", "$replacement"));
    await stashRecoveredDraft(session);
    const entry = usePromptStashStore
      .getState()
      .entries.find((entry) => entry.queueEditSide === "edited")!;
    await restoreQueueEditStash(entry, other, other.environmentId);
    const restored = useComposerDraftStore.getState().getComposerDraft(other)!;
    expect(collectSelectedScientSkillNames(restored.prompt)).toEqual(["replacement"]);
    expect(restored.terminalContexts[0]?.text).toBe("$contextskill data");
    expect(
      projectComposerContextForProvider({
        text: restored.prompt,
        records: buildMessageContext(restored)!.records,
      }),
    ).toContain("$contextskill data");
    expect(restored.modelSelectionByProvider[modelSelection.instanceId]).toEqual(modelSelection);
    expect(await restored.files[0]?.file?.text()).toBe("hello");
    const recovered = useQueueEditSessions.getState().sessions[composerTargetKey(other)]!;
    expect(recovered.transferred).toBe(true);
    expect((await readQueueEditJournal(recovered.journalKey))?.edited.files[0]?.file).toBeDefined();
    expect(
      await (await readQueueEditJournal(recovered.journalKey))?.edited.files[0]?.file?.text(),
    ).toBe("hello");
  });
  it("keeps typing received during an accepted send in the ordinary composer and recovery journal", async () => {
    await beginQueueEdit(target, item);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    const submitted = useComposerDraftStore.getState().getComposerDraft(target)!;
    useComposerDraftStore.getState().setPrompt(target, "late transcript");
    expect(await finishQueueEdit(session, submitted)).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "late transcript",
    );
    expect((await readQueueEditJournal(session.journalKey))?.edited.prompt).toBe("late transcript");
    expect(useQueueEditSessions.getState().sessions[session.key]?.transferred).toBe(true);
  });
  it("does not expose an ambiguously extracted item as sendable and retries its same durable token", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary draft");
    vi.mocked(controlThreadQueue).mockRejectedValueOnce(new Error("connection interrupted"));
    await expect(beginQueueEdit(target, item)).rejects.toThrow("connection interrupted");
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(session.transferred).not.toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "ordinary draft",
    );
    const token = vi.mocked(controlThreadQueue).mock.calls[0]?.[1].editToken;
    expect((await readQueueEditJournal(session.journalKey))?.editToken).toBe(token);
    const reconciled = await flushQueueEdit(session);
    expect(reconciled.transferred).toBe(true);
    expect(reconciled.queueItemId).toBe(session.queueItemId);
    expect(vi.mocked(controlThreadQueue).mock.lastCall?.[1].editToken).toBe(token);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
    expect(useQueueEditSessions.getState().sessions[session.key]?.transferred).toBe(true);
  });
  it("preserves typing in the previous draft while extraction is in flight and never overwrites another thread", async () => {
    const extraction = deferred<ScientThreadQueueSnapshot>();
    const entered = deferred<void>();
    vi.mocked(controlThreadQueue).mockImplementationOnce(() => {
      entered.resolve();
      return extraction.promise;
    });
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    useComposerDraftStore.getState().setPrompt(other, "other");
    const editing = beginQueueEdit(target, item);
    await entered.promise;
    useComposerDraftStore.getState().setPrompt(target, "ordinary with late transcript");
    useComposerDraftStore.getState().setPrompt(other, "continued elsewhere");
    extraction.resolve({ threadId: target.threadId, items: [], revision: 1 });
    await editing;
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect((await readQueueEditJournal(session.journalKey))?.ordinary.prompt).toBe(
      "ordinary with late transcript",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(other)?.prompt).toBe(
      "continued elsewhere",
    );
  });
  it("keeps the ordinary draft when extraction definitely loses to delivery", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    vi.mocked(controlThreadQueue).mockRejectedValueOnce(
      new ScientThreadQueueOperationError({ message: "Already started" }),
    );
    await expect(beginQueueEdit(target, item)).rejects.toThrow("Already started");
    expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("ordinary");
  });
  it("preserves unsupported legacy skill provenance instead of extracting a guessed selection", async () => {
    await expect(
      beginQueueEdit(target, {
        ...item,
        text: "request\n<terminal_context>\n$contextskill\n</terminal_context>",
      }),
    ).rejects.toThrow("older queue edit");
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
  });
  it("does not extract when browser locks are unavailable or another window owns the draft", async () => {
    useComposerDraftStore.getState().setPrompt(target, "ordinary");
    vi.stubGlobal("navigator", {});
    await expect(beginQueueEdit(target, item)).rejects.toThrow("Use HTTPS or localhost");
    vi.stubGlobal("navigator", {
      locks: {
        request: (_key: string, _options: unknown, callback: (lock: null) => Promise<void>) =>
          callback(null),
      },
    });
    await expect(beginQueueEdit(target, item)).rejects.toThrow("another window");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("ordinary");
  });
  it("restores a typed ordinary mobile payload without a web-only edit snapshot", async () => {
    const context = {
      id: "terminal-from-mobile",
      threadId: target.threadId,
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "$contextskill mobile data",
      createdAt: item.createdAt,
    };
    const composer = {
      ...createEmptyThreadDraft(),
      prompt: ensureInlineContextReferences("$requested inspect", [
        terminalContextReference(context),
      ]),
      terminalContexts: [context],
    };
    const queued = {
      ...item,
      text: composer.prompt,
      selectedScientSkillNames: ["requested"],
      context: buildMessageContext(composer),
    };
    vi.mocked(controlThreadQueue).mockImplementation(async (_environmentId, request) => ({
      ...request,
      items: [],
      revision: 1,
    }));
    await beginQueueEdit(target, queued);
    const restored = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(collectSelectedScientSkillNames(restored.prompt)).toEqual(["requested"]);
    expect(
      projectComposerContextForProvider({
        text: restored.prompt,
        records: buildMessageContext(restored)!.records,
      }),
    ).toContain("$contextskill mobile data");
  });
  it("keeps attachment chips bound to their bytes through server-owned IDs and stash reminting", async () => {
    const image = {
      type: "image" as const,
      id: "owned-image",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const file = {
      type: "file" as const,
      id: "owned-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const imageContextId = toKindScopedComposerContextId("image", "composer-image");
    const fileContextId = toKindScopedComposerContextId("file", "composer-file");
    const queued = {
      ...item,
      text: [
        formatInlineContextReference({
          kind: "image",
          contextId: imageContextId,
          label: image.name,
        }),
        formatInlineContextReference({ kind: "file", contextId: fileContextId, label: file.name }),
      ].join(" "),
      attachments: [image, file],
      selectedScientSkillNames: [],
      context: {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "image" as const,
            contextId: imageContextId,
            attachmentId: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            label: image.name,
          },
          {
            version: 1 as const,
            kind: "file" as const,
            contextId: fileContextId,
            attachmentId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            label: file.name,
          },
        ],
      },
    };
    vi.mocked(readQueuedAttachmentFile).mockImplementation(
      async (_environmentId, value) =>
        new File([value.type === "image" ? "plot" : "hello"], value.name, { type: value.mimeType }),
    );
    vi.mocked(controlThreadQueue).mockImplementation(async (_environmentId, request) => ({
      ...request,
      items: [],
      revision: 1,
    }));
    await beginQueueEdit(target, queued);
    const session = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    const extracted = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(extracted.images[0]?.id).toBe("composer-image");
    expect(extracted.files[0]?.id).toBe("composer-file");
    await stashRecoveredDraft(session);
    const entry = usePromptStashStore
      .getState()
      .entries.find((entry) => entry.queueEditSide === "edited")!;
    await restoreQueueEditStash(entry, other, other.environmentId);
    const restored = useComposerDraftStore.getState().getComposerDraft(other)!;
    const outgoing = buildMessageContext({
      ...restored,
      attachments: [...restored.images, ...restored.files].map((attachment) => ({
        attachment,
        attachmentId: attachment.id,
      })),
    })!;
    const referencedIds = collectComposerContextReferences(restored.prompt).map(
      (reference) => reference.contextId,
    );
    expect(outgoing.records.map((record) => record.contextId)).toEqual(referencedIds);
    expect(await restored.images[0]?.file.text()).toBe("plot");
    expect(await restored.files[0]?.file?.text()).toBe("hello");
  });
});

describe("native run extraction journal", () => {
  it("stashes the ordinary draft, installs captured native bytes only after cancellation, and retries one revision/token", async () => {
    const nativeRun = {
      runId: RunId.make("native-queued-run"),
      messageId: MessageId.make("native-message"),
      expectedUpdatedAt: item.updatedAt,
    };
    const nativeItem = { ...item, queueItemId: nativeRun.runId, selectedScientSkillNames: [] };
    useComposerDraftStore.getState().setPrompt(target, "ordinary draft to keep");
    vi.mocked(extractNativeQueuedRun)
      .mockRejectedValueOnce(new Error("ambiguous cancellation"))
      .mockResolvedValue({ sequence: 1 });
    await expect(beginQueueEdit(target, nativeItem, nativeRun)).rejects.toThrow(
      "ambiguous cancellation",
    );
    const partial = useQueueEditSessions.getState().sessions[composerTargetKey(target)]!;
    expect(partial.transferred).not.toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "ordinary draft to keep",
    );
    const saved = await readQueueEditJournal(partial.journalKey);
    expect(saved?.nativeRun).toEqual(nativeRun);
    expect(saved?.edited.prompt).toBe("queued text");
    // Retry from the actual persisted record, rather than the in-memory draft.
    const reloaded = (await readQueueEditJournal(partial.journalKey))!;
    expect(reloaded.nativeRun).toEqual(nativeRun);
    const complete = await flushQueueEdit(reloaded);
    expect(complete.transferred).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("queued text");
    const calls = vi.mocked(extractNativeQueuedRun).mock.calls.slice(-2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual([
      target.environmentId,
      {
        threadId: target.threadId,
        runId: nativeRun.runId,
        expectedUpdatedAt: item.updatedAt,
        editToken: complete.editToken,
      },
    ]);
    useComposerDraftStore.getState().setPrompt(target, "edited after extraction");
    const durable = await flushQueueEdit(complete);
    expect((await readQueueEditJournal(durable.journalKey))?.edited.prompt).toBe(
      "edited after extraction",
    );
    expect(vi.mocked(controlThreadQueue)).not.toHaveBeenCalled();
    expect(
      usePromptStashStore
        .getState()
        .entries.some((entry) => entry.prompt === "ordinary draft to keep"),
    ).toBe(true);
  });
});

it("releases a definitively refused native edit journal while keeping ordinary file bytes and allowing another edit", async () => {
  const ordinary = new File(["ordinary bytes"], "ordinary.txt", { type: "text/plain" });
  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [composerTargetKey(target)]: {
        ...createEmptyThreadDraft(),
        prompt: "Ordinary draft",
        files: [
          {
            type: "file",
            id: "ordinary",
            name: ordinary.name,
            mimeType: ordinary.type,
            sizeBytes: ordinary.size,
            file: ordinary,
          },
        ],
      },
    },
  });
  const nativeRun = {
    runId: RunId.make("delivered-run"),
    messageId: MessageId.make("delivered-message"),
    expectedUpdatedAt: item.updatedAt,
  };
  let failedJournalKey: string | undefined;
  vi.mocked(extractNativeQueuedRun).mockImplementationOnce(async (_environment, request) => {
    failedJournalKey = request.editToken;
    const commandId = CommandId.make(`client:queue-extract:${request.editToken}`);
    throw nativeQueueExtractionError(
      new OrchestrationV2DispatchCommandError({
        commandId,
        commandType: "queued-run.cancel",
        commandDisposition: "rejected",
        message: "Already delivered",
      }),
      commandId,
    );
  });
  await expect(
    beginQueueEdit(target, { ...item, queueItemId: nativeRun.runId }, nativeRun),
  ).rejects.toThrow("Already delivered");
  expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
  expect(failedJournalKey).toBeDefined();
  expect(await readQueueEditJournal(failedJournalKey!)).toBeUndefined();
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(draft.prompt).toBe("Ordinary draft");
  expect(await draft.files[0]?.file?.text()).toBe("ordinary bytes");
  vi.mocked(extractNativeQueuedRun).mockResolvedValueOnce({ sequence: 1 });
  await beginQueueEdit(
    target,
    { ...item, queueItemId: "fresh-run" },
    { ...nativeRun, runId: RunId.make("fresh-run") },
  );
  expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]?.transferred).toBe(
    true,
  );
});
