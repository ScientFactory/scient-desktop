import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  MessageId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  useComposerDraftStore,
  composerTargetKey,
  createEmptyThreadDraft,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import * as session from "../../state/session";
import * as extracted from "../../scient/threadQueue/extractedIntentSend";
import { useQueueEditSessions, finishQueueEdit } from "../../scient/threadQueue/editSession";
import * as queueClient from "../../scient/threadQueue/client";
import { readExtractedIntent, writeQueueEditJournal } from "../../scient/threadQueue/editJournal";
import { usePromptStashStore } from "../../promptStashStore";
import type { ExtractedSubmissionPacket } from "../../scient/threadQueue/submission";
import type { ChatComposerHandle } from "./ChatComposer";
import { draftSendState } from "./chatViewSend";
import { useComposerSend, type ComposerSendInput } from "./useComposerSend";
import { useComposerResume } from "./useComposerResume";
import { useImplementPlanInNewThread } from "./useProposedPlanSend";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";
import {
  countPreparingComposerImages,
  removePreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import * as imageCompression from "../../lib/imageCompression";
import type { ChatMessage } from "../../types";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { composerSubmissionMatchesDraft } from "../../scient/threadQueue/submission";
import { toastManager } from "../ui/toast";
import * as chatViewLogic from "../ChatView.logic";

const bindings = vi.hoisted(() => ({
  command: vi.fn<
    (packet: ExtractedSubmissionPacket) => Promise<AtomCommandResult<{ queued: boolean }, unknown>>
  >(async () => AsyncResult.success({ queued: false })),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => bindings.command,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: () => false,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => {},
}));
vi.mock("@tanstack/react-router", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../scient/threadQueue/client", { spy: true });
vi.mock("../../scient/threadQueue/extractedIntentSend", { spy: true });
vi.mock("../../lib/imageCompression", { spy: true });
vi.mock("../ChatView.logic", { spy: true });

function deferredRecovery() {
  const result =
    Promise.withResolvers<Awaited<ReturnType<typeof extracted.beginExtractedSubmission>>>();
  const begin = vi.mocked(extracted.beginExtractedSubmission);
  begin.mockImplementationOnce(() => result.promise);
  return {
    ...result,
    begin,
    [Symbol.dispose]: () => begin.mockReset(),
  };
}

let sequence = 0;
async function setup(overrides: Partial<ComposerSendInput> = {}) {
  const stack = new AsyncDisposableStack();
  try {
    bindings.command.mockReset().mockResolvedValue(AsyncResult.success({ queued: false }));
    const navigate = vi.fn(async () => {});
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(session.readEnvironmentScope).mockReset().mockReturnValue(true);
    vi.mocked(extracted.beginExtractedSubmission).mockReset();
    vi.mocked(imageCompression.prepareImageForAttachment).mockReset();
    vi.mocked(queueClient.extractNativeQueuedRun).mockReset();
    stack.defer(() => {
      vi.mocked(queueClient.extractNativeQueuedRun).mockReset();
    });
    stack.defer(() => {
      vi.mocked(session.readEnvironmentScope).mockReset();
    });
    const before = useComposerDraftStore.getState();
    stack.defer(() => {
      useComposerDraftStore.setState(before, true);
    });
    const storage = new Map<string, string>();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    stack.defer(() => {
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    const environmentId = EnvironmentId.make(`send-owner-${++sequence}`);
    const threadId = ThreadId.make("thread");
    const target = scopeThreadRef(environmentId, threadId);
    const routeKey = scopedThreadKey(target);
    const route = { current: routeKey };
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "gpt-5.4" };
    const now = DateTime.makeUnsafe("2026-10-20T00:00:00Z");
    const activeThread = scopeThreadShell(environmentId, {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Synthetic thread",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 1,
      visibleItemCount: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });
    const prompt = "$captured Please investigate";
    useComposerDraftStore.getState().setPrompt(target, prompt);
    let context: ReturnType<ChatComposerHandle["getSendContext"]> = {
      pendingAttachments: false,
      answeringPendingUserInput: false,
      prompt,
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      selectedPromptEffort: null,
      selectedModelOptionsForDispatch: undefined,
      selectedModelSelection: modelSelection,
      multipleModelSelections: null,
      providerAvailable: true,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: modelSelection.model,
      selectedProviderModels: [],
      interactionMode: "default",
      interactionModeEnabled: true,
      shownPendingApprovalIds: [],
    };
    const noop = () => {};
    const never = async () => {
      throw new Error("This queue operation is not part of the fixture");
    };
    const handle: ChatComposerHandle = {
      focusAtEnd: noop,
      focusAt: noop,
      restoreAfterTimelineReachedEnd: noop,
      collapseForTimelineScrollKey: noop,
      addDroppedFiles: noop,
      addDroppedFolders: noop,
      hasPendingAttachments: () => countPreparingComposerImages(composerTargetKey(target)) > 0,
      insertTextAtEnd: () => true,
      pasteTextAtEnd: () => true,
      citeAssistantText: () => true,
      citeText: () => true,
      openModelPicker: noop,
      stepReasoningEffort: noop,
      toggleModelPicker: noop,
      openControl: noop,
      isModelPickerOpen: () => false,
      isCaretAtStart: () => true,
      compactContext: noop,
      readSnapshot: () => ({ value: context.prompt, cursor: 0, expandedCursor: 0, contextIds: [] }),
      resetCursorState: vi.fn(),
      addTerminalContext: noop,
      getSendContext: () => ({
        ...context,
        pendingAttachments:
          context.pendingAttachments || countPreparingComposerImages(composerTargetKey(target)) > 0,
      }),
      validateProviderInput: () => true,
      setMultipleModelSelections: noop,
    };
    const composerImagesRef: Parameters<
      typeof useComposerAttachmentIntake
    >[0]["composerImagesRef"] = { current: [] };
    const composerFilesRef: Parameters<typeof useComposerAttachmentIntake>[0]["composerFilesRef"] =
      { current: [] };
    const input: ComposerSendInput = {
      environmentId,
      routeThreadKey: routeKey,
      currentRouteThreadKeyRef: route,
      queueContextKeyRef: { current: routeKey },
      queueEditsReady: true,
      threadQueue: {
        items: [],
        awaitingCompletion: false,
        refresh: async () => {},
      },
      serverProjection: null,
      hasHeldQueuedRuns: false,
      onForkConversation: noop,
      captureSendReadingPosition: () => ({
        atEnd: true,
        firstMessage: false,
        threadKey: routeKey,
        navigationGeneration: 0,
      }),
      frameSubmittedMessage: noop,
      draftId: null,
      draftThread: null,
      activeThread,
      activeThreadKey: routeKey,
      activeThreadBranch: null,
      activeProject: {
        environmentId,
        id: activeThread.projectId,
        title: "Synthetic project",
        workspaceRoot: "/synthetic/send-owner",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
      },
      activeProjectDefaultModelSelection: null,
      activeProposedPlan: null,
      activeMessageCount: 1,
      isServerThread: true,
      isLocalDraftThread: false,
      isGitRepo: false,
      phase: "ready",
      sendEnvMode: "local",
      startFromOrigin: false,
      localCheckoutBranchMismatch: null,
      logicalProjectEnvironments: [],
      providerInstanceEntries: [],
      composerRef: { current: handle },
      composerDraftTarget: target,
      promptRef: { current: prompt },
      feedbackUploadsInFlightRef: { current: new Set() },
      isConnecting: false,
      isRevertingCheckpoint: false,
      threadDetailLoading: false,
      activeEnvironmentUnavailable: false,
      isSendBusy: false,
      sendQueuesBehindSetup: false,
      isDraftHeroState: false,
      panelAnimationsActive: false,
      panelAnimationDurationMs: 0,
      keepFullHistory: true,
      resumeCompactionTokens: null,
      showPlanFollowUpPrompt: false,
      usageLimitsKey: null,
      usageLimitsOffered: false,
      openUsageLimits: () => false,
      clearUsageLimitsFor: noop,
      needsLoadBalancing: false,
      loadBalancing: { pending: false, failed: false, environmentId, refresh: noop },
      readPendingEnvironmentChange: () => null,
      pendingApprovals: [],
      respondingRequestIds: [],
      activePendingProgress: null,
      onAdvanceActivePendingUserInput: noop,
      onRespondToApproval: never,
      beginLocalDispatch: noop,
      resetLocalDispatch: noop,
      beginWorktreeSetup: noop,
      captureDraftHeroComposerRect: noop,
      setDockedDraftHeroThreadKey: noop,
      setSetupQueueSendThreadKey: noop,
      setOptimisticUserMessages: noop,
      setFeedbackSubmissionsByThreadKey: noop,
      setThreadError: vi.fn(),
      setKeepFullHistory: noop,
      acknowledgeActiveThreadWoke: noop,
      handleInteractionModeChange: noop,
      handleNewThreadInActiveProject: noop,
      persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
      ...overrides,
    };
    let send: ReturnType<typeof useComposerSend>["onSend"] | undefined;
    let resume: ReturnType<typeof useComposerResume>["onResume"] | undefined;
    let intake:
      | ReturnType<typeof useComposerAttachmentIntake>["addComposerAttachments"]
      | undefined;
    let fanout: ReturnType<typeof useMultipleModelSend> | undefined;
    let implement: ReturnType<typeof useImplementPlanInNewThread> | undefined;
    let preparingImages: ReturnType<typeof usePreparingComposerImages> = [];
    let removeImage:
      | ReturnType<typeof useComposerAttachmentIntake>["removeComposerImage"]
      | undefined;
    const duplicateImageCommits: string[][] = [];
    function Owner() {
      const preparing = usePreparingComposerImages(composerTargetKey(target));
      const readyImages = useComposerThreadDraft(target).images;
      const onSend = useComposerSend(input).onSend;
      const sendMultiple = useMultipleModelSend(input);
      const implementPlan = useImplementPlanInNewThread({
        ...input,
        defaultRuntimeMode: "full-access",
      });
      const { addComposerAttachments, removeComposerImage } = useComposerAttachmentIntake({
        environmentId,
        attachmentDraftTarget: target,
        activeThreadId: threadId,
        activePendingProgress: null,
        activePendingIsResponding: false,
        pendingUserInputs: [],
        supportsQuestionAttachments: false,
        isLiteralPendingAnswer: false,
        isConnecting: false,
        projectSelectionRequired: false,
        questionAttachmentTarget: null,
        attachmentTargetKey: composerTargetKey(target),
        fileStagingLimit: 100 * 1024 * 1024,
        promptRef: input.promptRef,
        composerImagesRef,
        composerFilesRef,
        composerEditorRef: { current: null },
        isRevertingCheckpointRef: { current: false },
        setThreadError: input.setThreadError,
        countReservedAttachments: () => {
          const draft = useComposerDraftStore.getState().getComposerDraft(target);
          return (
            (draft?.images.length ?? 0) +
            (draft?.files.length ?? 0) +
            countPreparingComposerImages(composerTargetKey(target))
          );
        },
        addComposerImage: (image) => useComposerDraftStore.getState().addImages(target, [image]),
        addComposerImagesToDraft: (images) =>
          useComposerDraftStore.getState().addImages(target, images),
        addComposerFilesToDraft: (files) =>
          useComposerDraftStore.getState().addFiles(target, files),
        removeComposerImageFromDraft: (id) =>
          useComposerDraftStore.getState().removeImage(target, id),
        insertAttachmentReferences: () => true,
      });
      const { onResume } = useComposerResume({
        ...input,
        resumableRunId: RunId.make("resume"),
        runtimeMode: "full-access",
        interactionMode: "default",
        scrollToEnd: noop,
      });
      useLayoutEffect(() => {
        send = onSend;
        resume = onResume;
        intake = addComposerAttachments;
        removeImage = removeComposerImage;
        preparingImages = preparing;
        fanout = sendMultiple;
        implement = implementPlan;
      }, [
        onSend,
        onResume,
        addComposerAttachments,
        removeComposerImage,
        preparing,
        sendMultiple,
        implementPlan,
      ]);
      // The attachment strip keys ready and preparing tiles by image id.
      useLayoutEffect(() => {
        const duplicated = readyImages.flatMap((image) =>
          preparing.some((candidate) => candidate.id === image.id) ? [image.id] : [],
        );
        if (duplicated.length > 0) duplicateImageCommits.push(duplicated);
      }, [preparing, readyImages]);
      return null;
    }
    // Navigation is a command adapter here, not the fixture router.
    stack.use(await render(<Owner />, { router: false }));
    if (!send || !resume || !intake || !fanout || !implement || !removeImage)
      throw new Error("The composer owners did not render");
    stack.defer(() => {
      removePreparingComposerImages(
        composerTargetKey(target),
        new Set(preparingImages.map((image) => image.id)),
      );
      draftSendState(routeKey).sendInFlight.current = false;
      draftSendState(routeKey).uncertainSubmissions.current.clear();
    });
    return {
      input,
      send,
      resume,
      intake,
      fanout,
      implement,
      navigate,
      removeImage,
      get preparingImages() {
        return preparingImages;
      },
      storage,
      duplicateImageCommits,
      route,
      command: bindings.command,
      get context() {
        return context;
      },
      set context(next) {
        context = next;
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

function fanoutInput(fixture: Awaited<ReturnType<typeof setup>>) {
  const project = fixture.input.activeProject;
  const threadId = fixture.input.activeThread?.id;
  if (!project || !threadId) throw new Error("Expected the synthetic thread and project");
  const selection = fixture.context.selectedModelSelection;
  const draftAtSend = useComposerDraftStore
    .getState()
    .getComposerDraft(fixture.input.composerDraftTarget);
  return {
    threadId,
    project,
    branch: "main",
    selections: [selection],
    targets: [{ selection, text: fixture.context.prompt, interactionMode: "default" }],
    sendSnapshot: {
      images: [],
      files: [],
      attachments: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      messageText: fixture.context.prompt,
    },
    createdAt: "2026-10-20T00:00:00Z",
    attachmentsPromise: Promise.resolve([]),
    usesAttachmentUploads: false,
    readFileBlockReason: () => null,
    buildOutgoingMessageContext: () => undefined,
    isCurrentSend: () => true,
    isCurrentDraft: () =>
      fixture.route.current === fixture.input.routeThreadKey &&
      composerSubmissionMatchesDraft(
        draftAtSend,
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ),
    selectedScientSkillNames: ["captured"],
    runtimeMode: "full-access",
  } satisfies Parameters<ReturnType<typeof useMultipleModelSend>>[0];
}

describe("mounted composer send admission owner", () => {
  it.each(["/compact keep the API notes", "/compact\n  tests"])(
    "dispatches an instructed compaction once without a preceding bare command: %s",
    async (prompt) => {
      await using fixture = await setup({
        keepFullHistory: false,
        resumeCompactionTokens: 120_000,
      });
      fixture.context = { ...fixture.context, prompt };
      fixture.input.promptRef.current = prompt;
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      await fixture.send();
      expect(fixture.command).toHaveBeenCalledTimes(1);
      expect(fixture.command.mock.calls[0]?.[0].input.message.text).toBe(prompt);
      expect(fixture.command.mock.calls[0]?.[0].input.dispatchMode).toBe("auto");
    },
  );

  it.each(["unchanged", "new text", "retyped same text"] as const)(
    "sends feedback only to the shown request and retains newer typing: %s",
    async (editWhileReplying) => {
      const requestId = RuntimeRequestId.make("feedback-request");
      const reply = Promise.withResolvers<AtomCommandResult<unknown, unknown>>();
      const started = Promise.withResolvers<void>();
      const respond = vi.fn(async () => {
        started.resolve();
        return reply.promise;
      });
      await using fixture = await setup({
        pendingApprovals: [
          {
            requestId,
            requestKind: "command",
            createdAt: "2026-10-24T00:00:00Z",
            responseCapability: "live",
            supportsFeedback: true,
          },
        ],
        onRespondToApproval: respond,
      });
      const prompt = "Keep the tests";
      fixture.context = { ...fixture.context, prompt, shownPendingApprovalIds: [requestId] };
      fixture.input.promptRef.current = prompt;
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      const sending = fixture.send();
      await started.promise;
      await fixture.send();
      if (editWhileReplying !== "unchanged") {
        fixture.input.promptRef.current = "New draft";
        useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "New draft");
        if (editWhileReplying === "retyped same text") {
          fixture.input.promptRef.current = prompt;
          useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
        }
      }
      reply.resolve(AsyncResult.success(undefined));
      await sending;
      expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "decline", prompt);
      expect(fixture.command).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
          ?.prompt ?? "",
      ).toBe(
        editWhileReplying === "unchanged"
          ? ""
          : editWhileReplying === "new text"
            ? "New draft"
            : prompt,
      );
    },
  );

  it("retains feedback and attachments without declining the request or dispatching a parent turn", async () => {
    const requestId = RuntimeRequestId.make("feedback-with-file");
    const respond = vi.fn();
    await using fixture = await setup({
      pendingApprovals: [
        {
          requestId,
          requestKind: "command",
          createdAt: "2026-10-24T00:00:00Z",
          responseCapability: "live",
          supportsFeedback: true,
        },
      ],
      onRespondToApproval: respond,
    });
    fixture.context = {
      ...fixture.context,
      shownPendingApprovalIds: [requestId],
      files: [
        {
          type: "file",
          id: "paper",
          name: "paper.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          file: new File(["pdf"], "paper.pdf", { type: "application/pdf" }),
        },
      ],
    };
    const before = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    await fixture.send();
    expect(respond).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(before);
    expect(fixture.input.setThreadError).toHaveBeenLastCalledWith(
      fixture.input.activeThread?.id,
      "Send approval feedback without attachments or added context.",
    );
  });

  it("keeps the feedback draft when the native reply fails", async () => {
    const requestId = RuntimeRequestId.make("failed-feedback");
    const failure = await settlePromise(async () => {
      throw new Error("Reply rejected");
    });
    const respond = vi.fn(async () => failure);
    await using fixture = await setup({
      pendingApprovals: [
        {
          requestId,
          requestKind: "command",
          createdAt: "2026-10-24T00:00:00Z",
          responseCapability: "live",
          supportsFeedback: true,
        },
      ],
      onRespondToApproval: respond,
    });
    fixture.context = { ...fixture.context, shownPendingApprovalIds: [requestId] };
    const before = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    await fixture.send();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(fixture.command).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(before);
  });

  it.each(["/plan", "/default", "/fork"])(
    "runs the local %s command without declining a shown feedback request",
    async (prompt) => {
      const requestId = RuntimeRequestId.make("local-command-feedback");
      const respond = vi.fn();
      const handleInteractionModeChange = vi.fn();
      const onForkConversation = vi.fn();
      await using fixture = await setup({
        pendingApprovals: [
          {
            requestId,
            requestKind: "command",
            createdAt: "2026-10-24T00:00:00Z",
            responseCapability: "live",
            supportsFeedback: true,
          },
        ],
        onRespondToApproval: respond,
        handleInteractionModeChange,
        onForkConversation,
      });
      fixture.context = { ...fixture.context, prompt, shownPendingApprovalIds: [requestId] };
      fixture.input.promptRef.current = prompt;
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      await fixture.send();
      expect(respond).not.toHaveBeenCalled();
      expect(fixture.command).not.toHaveBeenCalled();
      expect(onForkConversation).toHaveBeenCalledTimes(prompt === "/fork" ? 1 : 0);
      expect(handleInteractionModeChange.mock.calls).toEqual(
        prompt === "/fork" ? [] : [[prompt.slice(1)]],
      );
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
          ?.prompt ?? "",
      ).toBe("");
    },
  );

  it("leaves a shown feedback request and its draft alone when the provider rejects the text", async () => {
    const requestId = RuntimeRequestId.make("rejected-feedback");
    const respond = vi.fn();
    await using fixture = await setup({
      pendingApprovals: [
        {
          requestId,
          requestKind: "command",
          createdAt: "2026-10-24T00:00:00Z",
          responseCapability: "live",
          supportsFeedback: true,
        },
      ],
      onRespondToApproval: respond,
    });
    const composer = fixture.input.composerRef.current;
    if (!composer) throw new Error("Expected the synthetic composer");
    fixture.input.composerRef.current = { ...composer, validateProviderInput: () => false };
    fixture.context = { ...fixture.context, shownPendingApprovalIds: [requestId] };
    const before = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    await fixture.send();
    expect(respond).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(before);
  });

  it("does not answer a feedback request after navigation during queue recovery", async () => {
    const requestId = RuntimeRequestId.make("stale-feedback");
    const respond = vi.fn();
    await using fixture = await setup({
      pendingApprovals: [
        {
          requestId,
          requestKind: "command",
          createdAt: "2026-10-24T00:00:00Z",
          responseCapability: "live",
          supportsFeedback: true,
        },
      ],
      onRespondToApproval: respond,
    });
    fixture.context = { ...fixture.context, shownPendingApprovalIds: [requestId] };
    using recovery = deferredRecovery();
    const sending = fixture.send();
    fixture.route.current = "another-thread";
    recovery.resolve({ intent: undefined, retryResult: undefined });
    await sending;
    expect(respond).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
  });

  it("drops a removed preparing tile and drains reservations after a rejected conversion", async () => {
    await using fixture = await setup();
    const converted =
      Promise.withResolvers<
        Awaited<ReturnType<typeof imageCompression.prepareImageForAttachment>>
      >();
    vi.mocked(imageCompression.prepareImageForAttachment).mockImplementationOnce(
      () => converted.promise,
    );
    let adding!: Promise<boolean>;
    await act(() => {
      adding = fixture.intake([new File(["image"], "cancelled.png", { type: "image/png" })]);
    });
    const targetKey = composerTargetKey(fixture.input.composerDraftTarget);
    expect(countPreparingComposerImages(targetKey)).toBe(1);
    await fixture.send();
    expect(fixture.command).not.toHaveBeenCalled();
    const imageId = fixture.preparingImages[0]!.id;
    await act(() => fixture.removeImage(imageId));
    converted.reject(new Error("decode failed"));
    await adding;
    expect(countPreparingComposerImages(targetKey)).toBe(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)?.images,
    ).toEqual([]);
    expect(fixture.input.setThreadError).not.toHaveBeenCalledWith(
      fixture.input.activeThread?.id,
      expect.stringContaining("could not be read"),
    );
  });
  async function replaysFrozenAdmissionAfterLostAck(feedbackShown: boolean) {
    const frameSubmittedMessage = vi.fn();
    const setOptimisticUserMessages = vi.fn();
    const requestId = RuntimeRequestId.make("captured-feedback");
    const respond = vi.fn(async () => AsyncResult.success(undefined));
    await using fixture = await setup({
      frameSubmittedMessage,
      setOptimisticUserMessages,
      // A captured queue record is not feedback: it declines shown approvals and dispatches.
      pendingApprovals: feedbackShown
        ? [
            {
              requestId,
              requestKind: "command",
              createdAt: "2026-10-24T00:00:00Z",
              responseCapability: "live",
              supportsFeedback: true,
            },
          ]
        : [],
      onRespondToApproval: respond,
    });
    fixture.context = {
      ...fixture.context,
      shownPendingApprovalIds: feedbackShown ? [requestId] : [],
    };
    await using edits = new AsyncDisposableStack();
    const sessionsBefore = useQueueEditSessions.getState();
    const stashBefore = usePromptStashStore.getState();
    const key = composerTargetKey(fixture.input.composerDraftTarget);
    const journalKey = `00000000-0000-4000-8000-00000000000${feedbackShown ? 2 : 1}`;
    const ordinary = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    if (!ordinary) throw new Error("Expected the synthetic ordinary draft");
    edits.defer(async () => {
      try {
        const owned = useQueueEditSessions.getState().sessions[key];
        if (owned) await finishQueueEdit(owned);
        await writeQueueEditJournal(journalKey);
        await writeQueueEditJournal(`intent:${journalKey}`);
        for (const entry of usePromptStashStore.getState().entries) {
          if (entry.queueEditKey === journalKey) usePromptStashStore.getState().takeEntry(entry.id);
        }
      } finally {
        useQueueEditSessions.setState(sessionsBefore, true);
        usePromptStashStore.setState(stashBefore, true);
      }
    });
    vi.mocked(queueClient.extractNativeQueuedRun).mockResolvedValue({ sequence: 1 });
    const edited = { ...createEmptyThreadDraft(), prompt: "$recovered Queue edit" };
    useQueueEditSessions.setState({
      sessions: {
        [key]: {
          key,
          journalKey,
          originalTarget: fixture.input.composerDraftTarget,
          editTarget: fixture.input.composerDraftTarget,
          queueItemId: "native-run",
          editToken: journalKey,
          ordinary,
          edited,
          composerSeparated: true,
          nativeRun: {
            runId: RunId.make("native-run"),
            messageId: MessageId.make("native-message"),
            expectedUpdatedAt: "2026-10-20T00:00:00Z",
          },
        },
      },
    });
    await fixture.send();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(frameSubmittedMessage).not.toHaveBeenCalled();
    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toMatchObject({ prompt: edited.prompt, extractedIntent: { intentId: journalKey } });
    expect(usePromptStashStore.getState().entries).toContainEqual(
      expect.objectContaining({
        prompt: ordinary.prompt,
        queueEditKey: journalKey,
        queueEditSide: "ordinary",
      }),
    );
    fixture.context = { ...fixture.context, prompt: edited.prompt };
    const lostAck = await settlePromise(async () => {
      throw new Error("Lost extracted acknowledgement");
    });
    if (lostAck._tag !== "Failure") throw new Error("Expected a synthetic failure");
    fixture.command.mockResolvedValueOnce(lostAck);
    await fixture.send();
    expect(
      fixture.command,
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      selectedScientSkillNames: ["recovered"],
      message: { text: expect.stringContaining("$recovered Queue edit") },
    });
    const first = fixture.command.mock.calls[0]?.[0];
    expect(await readExtractedIntent(journalKey)).toMatchObject({ phase: "submitted-unknown" });
    expect(respond.mock.calls).toEqual(feedbackShown ? [[requestId, "decline"]] : []);
    fixture.context = {
      ...fixture.context,
      selectedModel: "later-model",
      selectedModelSelection: { ...fixture.context.selectedModelSelection, model: "later-model" },
    };
    await fixture.send();
    expect(fixture.command).toHaveBeenCalledTimes(2);
    expect(fixture.command.mock.calls[1]?.[0]).toEqual(first);
    expect(vi.mocked(queueClient.extractNativeQueuedRun)).toHaveBeenCalledTimes(1);
    expect(await readExtractedIntent(journalKey)).toMatchObject({ phase: "consumed" });
    expect(useQueueEditSessions.getState().sessions[key]).toBeUndefined();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
        ?.prompt ?? "",
    ).toBe("");
    // The frozen retry replays its recorded admission without a second decline.
    expect(respond).toHaveBeenCalledTimes(feedbackShown ? 1 : 0);
  }
  it.each([false, true])(
    "fences a transferred draft and replays its frozen native admission after a lost ACK (shown feedback request: %s)",
    replaysFrozenAdmissionAfterLostAck,
  );
  it.each([false, true])(
    "waits for implementation visibility before navigating and keeps the authored draft (visible: %s)",
    async (visible) => {
      await using fixture = await setup({
        activeProposedPlan: {
          id: PlanId.make("plan"),
          createdAt: "2026-10-20T00:00:00Z",
          updatedAt: "2026-10-20T00:00:00Z",
          runId: null,
          planMarkdown: "Implement this plan",
          status: "completed",
        },
      });
      const entered = Promise.withResolvers<void>();
      const visibility = Promise.withResolvers<boolean>();
      using wait = vi.spyOn(chatViewLogic, "waitForStartedServerThread").mockImplementation(() => {
        entered.resolve();
        return visibility.promise;
      });
      const implementing = fixture.implement();
      await entered.promise;
      const packet = fixture.command.mock.calls[0]?.[0];
      if (!packet) throw new Error("Implementation command missing");
      expect(wait).toHaveBeenCalledWith(
        scopeThreadRef(fixture.input.environmentId, packet.input.threadId),
      );
      expect(fixture.navigate).not.toHaveBeenCalled();
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(true);
      useComposerDraftStore
        .getState()
        .setPrompt(fixture.input.composerDraftTarget, "New authoring while the shell catches up");
      const newer = useComposerDraftStore
        .getState()
        .getComposerDraft(fixture.input.composerDraftTarget);
      visibility.resolve(visible);
      await implementing;
      expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: fixture.input.environmentId, threadId: packet.input.threadId },
      });
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ).toBe(newer);
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
    },
  );
  it("does not navigate an implementation after its source route leaves during the projection wait", async () => {
    await using fixture = await setup({
      activeProposedPlan: {
        id: PlanId.make("plan"),
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
        runId: null,
        planMarkdown: "Implement this plan",
        status: "completed",
      },
    });
    const entered = Promise.withResolvers<void>();
    const visibility = Promise.withResolvers<boolean>();
    using _wait = vi.spyOn(chatViewLogic, "waitForStartedServerThread").mockImplementation(() => {
      entered.resolve();
      return visibility.promise;
    });
    const implementing = fixture.implement();
    await entered.promise;
    fixture.route.current = "another-environment:another-thread";
    visibility.resolve(true);
    await implementing;
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });
  it("retains an ambiguous new-thread implementation without deleting it or consuming the draft", async () => {
    await using fixture = await setup({
      activeProposedPlan: {
        id: PlanId.make("plan"),
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
        runId: null,
        planMarkdown: "Implement the $untrusted proposed plan",
        status: "completed",
      },
    });
    using _toast = vi.spyOn(toastManager, "add").mockReturnValue("synthetic-implementation-toast");
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
    fixture.command.mockImplementationOnce(() => {
      entered.resolve();
      return receipt.promise;
    });
    const implementing = fixture.implement();
    await entered.promise;
    useComposerDraftStore
      .getState()
      .setPrompt(fixture.input.composerDraftTarget, "Unrelated newer authoring");
    const newer = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    const failure = await settlePromise(async () => {
      throw new Error("Lost implementation acknowledgement");
    });
    if (failure._tag !== "Failure") throw new Error("Expected a synthetic failure");
    receipt.resolve(failure);
    await implementing;
    await fixture.implement();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      selectedScientSkillNames: [],
      modelSelection: { model: "gpt-5.4" },
      sourceProposedPlan: { threadId: fixture.input.activeThread?.id, planId: PlanId.make("plan") },
      bootstrap: { createThread: { projectId: fixture.input.activeProject?.id } },
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(newer);
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });
  it("carries captured settings and skills through fanout without releasing its parent's lock", async () => {
    await using fixture = await setup();
    using _toast = vi.spyOn(toastManager, "add").mockReturnValue("synthetic-fanout-toast");
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
    fixture.command.mockImplementationOnce(() => {
      entered.resolve();
      return receipt.promise;
    });
    const lock = draftSendState(fixture.input.routeThreadKey).sendInFlight;
    lock.current = true;
    const sending = fixture.fanout(fanoutInput(fixture));
    await entered.promise;
    expect(lock.current).toBe(true);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
        ?.prompt ?? "",
    ).toBe("");
    receipt.resolve(AsyncResult.success({ queued: false }));
    await sending;
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      selectedScientSkillNames: ["captured"],
      modelSelection: { model: "gpt-5.4" },
      runtimeMode: "full-access",
      bootstrap: { prepareWorktree: { requireWorktree: true } },
    });
    expect(lock.current).toBe(true);
  });

  it("keeps newer authoring when a fanout target loses its acknowledgement", async () => {
    await using fixture = await setup();
    using _toast = vi.spyOn(toastManager, "add").mockReturnValue("synthetic-fanout-toast");
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
    fixture.command.mockImplementationOnce(() => {
      entered.resolve();
      return receipt.promise;
    });
    const sending = fixture.fanout(fanoutInput(fixture));
    await entered.promise;
    useComposerDraftStore
      .getState()
      .setPrompt(fixture.input.composerDraftTarget, "Newer fanout draft");
    const newer = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    const failure = await settlePromise(async () => {
      throw new Error("Lost fanout acknowledgement");
    });
    if (failure._tag !== "Failure") throw new Error("Expected a synthetic failure");
    receipt.resolve(failure);
    await sending;
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(newer);
    fixture.context = { ...fixture.context, prompt: "Newer fanout draft" };
    await fixture.fanout(fanoutInput(fixture));
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)?.prompt,
    ).toBe("Newer fanout draft");
  });
  it("keeps a queued plan follow-up in the admission strip without framing it", async () => {
    let optimistic: ChatMessage[] = [];
    const frameSubmittedMessage = vi.fn();
    await using fixture = await setup({
      phase: "running",
      showPlanFollowUpPrompt: true,
      frameSubmittedMessage,
      activeProposedPlan: {
        id: PlanId.make("plan"),
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
        runId: null,
        planMarkdown: "A proposed plan",
        status: "completed",
      },
      setOptimisticUserMessages: (next) => {
        optimistic = typeof next === "function" ? next(optimistic) : next;
      },
    });
    fixture.command.mockResolvedValueOnce(AsyncResult.success({ queued: true }));
    await fixture.send();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(frameSubmittedMessage).not.toHaveBeenCalled();
    expect(optimistic).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("$captured"),
        queueAdmission: { threadKey: fixture.input.routeThreadKey, accepted: true },
      }),
    ]);
  });
  it("holds one admission lock and keeps settings and skills captured before recovery yields", async () => {
    await using fixture = await setup();
    using recovery = deferredRecovery();
    const first = fixture.send();
    await fixture.send();
    expect(recovery.begin).toHaveBeenCalledTimes(1);
    fixture.context = {
      ...fixture.context,
      prompt: "$later Different prompt",
      selectedModel: "later-model",
      selectedModelSelection: {
        ...fixture.context.selectedModelSelection,
        model: "later-model",
      },
    };
    recovery.resolve({ intent: undefined, retryResult: undefined });
    await first;
    expect(
      fixture.command,
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      selectedScientSkillNames: ["captured"],
      modelSelection: { model: "gpt-5.4" },
      runtimeMode: "full-access",
      message: { text: expect.stringContaining("$captured") },
    });
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });

  it.each(["draft changed", "route left"] as const)(
    "cancels before dispatch when %s during recovery",
    async (change) => {
      await using fixture = await setup();
      using recovery = deferredRecovery();
      const sending = fixture.send();
      if (change === "draft changed")
        useComposerDraftStore
          .getState()
          .setPrompt(fixture.input.composerDraftTarget, "Newer draft");
      else fixture.route.current = "another-route";
      const draft = useComposerDraftStore
        .getState()
        .getComposerDraft(fixture.input.composerDraftTarget);
      recovery.resolve({ intent: undefined, retryResult: undefined });
      await sending;
      expect(fixture.command).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ).toBe(draft);
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
    },
  );

  it("sends a direct steer without consuming the unrelated composer draft or files", async () => {
    await using fixture = await setup();
    fixture.context = {
      ...fixture.context,
      files: [
        {
          type: "file",
          id: "unrelated",
          name: "private-draft.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          file: new File(["pdf"], "private-draft.pdf", { type: "application/pdf" }),
        },
      ],
    };
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    if (!draft) throw new Error("Expected a synthetic draft");
    using editState = new DisposableStack();
    const before = useQueueEditSessions.getState();
    editState.defer(() => useQueueEditSessions.setState(before, true));
    const key = composerTargetKey(fixture.input.composerDraftTarget);
    const edit = {
      key,
      journalKey: key,
      originalTarget: fixture.input.composerDraftTarget,
      editTarget: fixture.input.composerDraftTarget,
      queueItemId: "unrelated-edit",
      editToken: "synthetic",
      ordinary: draft,
      edited: draft,
    };
    useQueueEditSessions.setState({ sessions: { [key]: edit } });
    await fixture.send(undefined, "auto", "foreground", undefined, {
      directPrompt: "Steer only",
      steer: true,
    });
    expect(
      fixture.command,
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      dispatchMode: "steer",
      selectedScientSkillNames: [],
      message: { text: "Steer only", attachments: [] },
    });
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(draft);
    expect(useQueueEditSessions.getState().sessions[key]).toBe(edit);
  });

  it("reuses the journal's command and message identity after a lost acknowledgement", async () => {
    await using fixture = await setup();
    const failed = await settlePromise(async () => {
      throw new Error("Lost acknowledgement");
    });
    if (failed._tag !== "Failure") throw new Error("Expected synthetic failure");
    fixture.command.mockResolvedValueOnce(failed);
    await fixture.send();
    const first = fixture.command.mock.calls[0]?.[0];
    expect(first, JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls)).toBeDefined();
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)?.prompt,
    ).toBe("$captured Please investigate");
    await fixture.send();
    const retry = fixture.command.mock.calls[1]?.[0];
    expect(retry?.input.commandId).toBe(first?.input.commandId);
    expect(retry?.input.message.messageId).toBe(first?.input.message.messageId);
    expect(
      fixture.storage.has(
        `scient-queue-submission:${composerTargetKey(fixture.input.composerDraftTarget)}`,
      ),
    ).toBe(false);
  });
  it.each(["ordinary", "plan"] as const)(
    "keeps a newer draft when a %s acknowledgement arrives late",
    async (kind) => {
      await using fixture = await setup({
        showPlanFollowUpPrompt: kind === "plan",
        activeProposedPlan: {
          id: PlanId.make("plan"),
          createdAt: "2026-10-20T00:00:00Z",
          updatedAt: "2026-10-20T00:00:00Z",
          runId: null,
          planMarkdown: "A proposed plan",
          status: "completed",
        },
      });
      const admitted = Promise.withResolvers<void>();
      const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
      fixture.command.mockImplementationOnce(() => {
        admitted.resolve();
        return receipt.promise;
      });
      const sending = fixture.send();
      await admitted.promise;
      useComposerDraftStore
        .getState()
        .setPrompt(fixture.input.composerDraftTarget, "Newer question");
      const newerDraft = useComposerDraftStore
        .getState()
        .getComposerDraft(fixture.input.composerDraftTarget);
      receipt.resolve(AsyncResult.success({ queued: false }));
      await sending;
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
          ?.prompt,
      ).toBe("Newer question");
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ).toBe(newerDraft);
    },
  );

  it("implements an empty-draft plan with provenance but no assistant-selected skills", async () => {
    await using fixture = await setup({
      showPlanFollowUpPrompt: true,
      activeProposedPlan: {
        id: PlanId.make("plan"),
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
        runId: null,
        planMarkdown: "Use $not-a-user-selection in the implementation",
        status: "completed",
      },
    });
    fixture.context = { ...fixture.context, prompt: "" };
    fixture.input.promptRef.current = "";
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "");
    await fixture.send();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      interactionMode: "default",
      selectedScientSkillNames: [],
      sourceProposedPlan: { threadId: "thread", planId: "plan" },
    });
  });

  it("releases the resume lock when settings fail before dispatch", async () => {
    await using fixture = await setup({
      persistThreadSettingsForNextTurn: async () => {
        throw new Error("Synthetic settings failure");
      },
    });
    await fixture.resume();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(fixture.input.setThreadError).toHaveBeenLastCalledWith(
      fixture.input.activeThread?.id,
      "Synthetic settings failure",
    );
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });

  it("does not frame or publish a stale draft while its submission identity is prepared", async () => {
    const frameSubmittedMessage = vi.fn();
    const setOptimisticUserMessages = vi.fn();
    await using fixture = await setup({ frameSubmittedMessage, setOptimisticUserMessages });
    const entered = Promise.withResolvers<void>();
    const fingerprint = Promise.withResolvers<ArrayBuffer>();
    using _digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => {
      entered.resolve();
      return fingerprint.promise;
    });
    const sending = fixture.send();
    await entered.promise;
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "Newer question");
    fingerprint.resolve(new ArrayBuffer(32));
    await sending;
    expect(fixture.command).not.toHaveBeenCalled();
    expect(frameSubmittedMessage).not.toHaveBeenCalled();
    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
  });

  it("does not start a continuation after leaving during its settings update", async () => {
    const entered = Promise.withResolvers<void>();
    const settings = Promise.withResolvers<AtomCommandResult<void, unknown>>();
    await using fixture = await setup({
      persistThreadSettingsForNextTurn: () => {
        entered.resolve();
        return settings.promise;
      },
    });
    const resuming = fixture.resume();
    await entered.promise;
    fixture.route.current = "another-route";
    settings.resolve(AsyncResult.success(undefined));
    await resuming;
    expect(fixture.command).not.toHaveBeenCalled();
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });

  it("stages a mixed attachment batch before committing either kind and swaps its placeholder in one commit", async () => {
    await using fixture = await setup();
    const converted =
      Promise.withResolvers<
        Awaited<ReturnType<typeof imageCompression.prepareImageForAttachment>>
      >();
    vi.mocked(imageCompression.prepareImageForAttachment).mockImplementationOnce(
      () => converted.promise,
    );
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const pdf = new File(["pdf"], "paper.pdf", { type: "application/pdf" });
    const adding = fixture.intake([pdf, image]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)?.files,
    ).toEqual([]);
    expect(countPreparingComposerImages(composerTargetKey(fixture.input.composerDraftTarget))).toBe(
      1,
    );
    converted.resolve({ ok: true, file: image, recompressed: false });
    await adding;
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    expect(draft?.files.map((file) => file.file)).toEqual([pdf]);
    expect(draft?.images.map((file) => file.file)).toEqual([image]);
    expect(countPreparingComposerImages(composerTargetKey(fixture.input.composerDraftTarget))).toBe(
      0,
    );
    expect(fixture.duplicateImageCommits).toEqual([]);
  });

  it("rechecks current attachment bytes after conversion and rejects the whole new batch", async () => {
    await using fixture = await setup();
    const converted =
      Promise.withResolvers<
        Awaited<ReturnType<typeof imageCompression.prepareImageForAttachment>>
      >();
    vi.mocked(imageCompression.prepareImageForAttachment).mockImplementationOnce(
      () => converted.promise,
    );
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const adding = fixture.intake([
      new File(["pdf"], "paper.pdf", { type: "application/pdf" }),
      image,
    ]);
    useComposerDraftStore.getState().addFiles(
      fixture.input.composerDraftTarget,
      Array.from({ length: 8 }, (_, index) => ({
        type: "file",
        id: `ready-${index}`,
        name: `ready-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
        file: null,
        uploadedAttachmentId: `synthetic-upload-${index}`,
      })),
    );
    const before = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    converted.resolve({ ok: true, file: image, recompressed: false });
    expect(await adding).toBe(false);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(before);
    expect(fixture.input.setThreadError).toHaveBeenLastCalledWith(
      fixture.input.activeThread?.id,
      expect.stringContaining("80 MiB"),
    );
    expect(countPreparingComposerImages(composerTargetKey(fixture.input.composerDraftTarget))).toBe(
      0,
    );
  });

  it("admits a plan follow-up under the same lock and clears only its matching draft", async () => {
    await using fixture = await setup({
      showPlanFollowUpPrompt: true,
      activeProposedPlan: {
        id: PlanId.make("plan"),
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
        runId: null,
        planMarkdown: "A proposed plan",
        status: "completed",
      },
    });
    await fixture.send();
    expect(
      fixture.command,
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].input).toMatchObject({
      interactionMode: "plan",
      runtimeMode: "full-access",
      selectedScientSkillNames: ["captured"],
      modelSelection: { model: "gpt-5.4" },
    });
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)
        ?.prompt ?? "",
    ).toBe("");
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
  });
});
