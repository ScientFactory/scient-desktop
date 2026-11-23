import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import {
  useComposerDraftStore,
  composerTargetKey,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import * as session from "../../state/session";
import * as submission from "../../scient/threadQueue/submission";
import type { ChatComposerHandle } from "./ChatComposer";
import { draftSendState } from "./chatViewSend";
import { useComposerSend, type ComposerSendInput } from "./useComposerSend";
import { useComposerResume } from "./useComposerResume";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";
import {
  countPreparingComposerImages,
  removePreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import * as imageCompression from "../../lib/imageCompression";
import * as roomComposer from "../../scient/room/roomComposer";
import { useMultipleModelSend } from "./useMultipleModelSend";
import type { useQueuedRunEdit } from "./useQueuedRunEdit";
import { toastManager } from "../ui/toast";
// SCIENT-FORK: `/feedback` opens Send feedback to Scient.
import { useFeedbackDraft } from "../../scient/feedback/feedbackStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { responseContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

const bindings = vi.hoisted(() => ({
  command: vi.fn<
    (packet: {
      readonly environmentId: EnvironmentId;
      readonly input: StartThreadTurnInput;
    }) => Promise<AtomCommandResult<{ queued: boolean }, unknown>>
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
  readPendingWorkspaceDefault: () => null,
}));
vi.mock("@tanstack/react-router", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../scient/threadQueue/submission", { spy: true });
vi.mock("../../lib/imageCompression", { spy: true });
vi.mock("../../scient/room/roomComposer", { spy: true });
vi.mock("../ChatView.logic", { spy: true });

/** Holds the send at its submission identity, its first yield before dispatch. */
function heldSubmissionIdentity() {
  const result = Promise.withResolvers<string>();
  const identify = vi.mocked(submission.queueSubmissionId);
  identify.mockImplementationOnce(() => result.promise);
  return {
    ...result,
    identify,
    [Symbol.dispose]: () => identify.mockReset(),
  };
}

function queuedRunEditStub(
  overrides: Partial<ReturnType<typeof useQueuedRunEdit>> = {},
): ReturnType<typeof useQueuedRunEdit> {
  return {
    editingRunId: null,
    isEditing: false,
    isSaving: false,
    draftTarget: scopeThreadRef(EnvironmentId.make("unused"), ThreadId.make("unused")),
    editingAttachments: null,
    removedEditingAttachments: [],
    beginEdit: vi.fn(),
    cancelEdit: vi.fn(),
    removeEditingAttachment: vi.fn(),
    restoreEditingAttachment: vi.fn(),
    saveEdit: vi.fn(async () => {}),
    ...overrides,
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
    vi.mocked(imageCompression.prepareImageForAttachment).mockReset();
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
      environmentContexts: [],
      selectedPromptEffort: null,
      selectedModelSelection: modelSelection,
      multipleModelSelections: null,
      providerAvailable: true,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: modelSelection.model,
      selectedProviderModels: [],
      shownPendingApprovalIds: [],
    };
    const noop = () => {};
    const never = async () => {
      throw new Error("This queue operation is not part of the fixture");
    };
    const handle: ChatComposerHandle = {
      focusAtEnd: noop,
      focusAt: noop,
      addDroppedFiles: noop,
      addDroppedFolders: noop,
      hasPendingAttachments: () => countPreparingComposerImages(composerTargetKey(target)) > 0,
      insertTextAtEnd: () => true,
      pasteTextAtEnd: () => true,
      citeAssistantText: () => true,
      replyToResponse: () => true,
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
      // Like the composer, a compressing image does not block: the send waits for it.
      getSendContext: () => context,
      validateProviderInput: () => true,
      setMultipleModelSelections: noop,
    };
    const composerImagesRef: Parameters<
      typeof useComposerAttachmentIntake
    >[0]["composerImagesRef"] = { current: [] };
    const composerFilesRef: Parameters<typeof useComposerAttachmentIntake>[0]["composerFilesRef"] =
      { current: [] };
    const input: ComposerSendInput = {
      sideChatDisabledReason: null,
      environmentId,
      routeThreadKey: routeKey,
      currentRouteThreadKeyRef: route,
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
      activeProjectIsScratch: false,
      activeProjectDefaultModelSelection: null,
      activeMessageCount: 1,
      isServerThread: true,
      isLocalDraftThread: false,
      isGitRepo: false,
      phase: "ready",
      sendEnvMode: "local",
      worktreeRepositories: undefined,
      startFromOrigin: false,
      localCheckoutBranchMismatch: null,
      logicalProjectEnvironments: [],
      providerInstanceEntries: [],
      composerRef: { current: handle },
      composerDraftTarget: target,
      promptRef: { current: prompt },
      feedbackUploadsInFlightRef: { current: new Set() },
      queuedRunEdit: queuedRunEditStub(),
      isRevertingCheckpoint: false,
      threadDetailLoading: false,
      activeEnvironmentUnavailable: false,
      isSendBusy: false,
      sendQueuesBehindSetup: false,
      isDraftHeroState: false,
      panelAnimationsActive: false,
      panelAnimationDurationMs: 0,
      keepFullHistory: true,
      freshSessionAvailable: false,
      resumeCompactionTokens: null,
      usageLimitsKey: null,
      usageLimitsOffered: false,
      openUsageLimits: () => false,
      clearUsageLimitsFor: noop,
      needsLoadBalancing: false,
      loadBalancing: {
        pending: false,
        failed: false,
        environmentId,
        refresh: noop,
        refreshSelection: async () => null,
      },
      readPendingEnvironmentChange: () => null,
      pendingApprovals: [],
      respondingRequestIds: [],
      activePendingUserInput: null,
      onAdvanceActivePendingUserInput: noop,
      onRespondToApproval: never,
      beginLocalDispatch: noop,
      resetLocalDispatch: noop,
      beginWorktreeSetup: noop,
      captureDraftHeroComposerRect: noop,
      setDockedDraftHeroThreadKey: noop,
      setSetupQueueSendThreadKey: noop,
      setOptimisticUserMessages: noop,
      optimisticBlobPreviews: { track: noop, release: noop },
      setFeedbackSubmissionsByThreadKey: noop,
      setThreadError: vi.fn(),
      setKeepFullHistory: noop,
      acknowledgeActiveThreadWoke: noop,
      handleNewThreadInActiveProject: noop,
      persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
      linkCheckoutPullRequest: noop,
      refreshBeforeSend: () => null,
      ...overrides,
    };
    let send: ReturnType<typeof useComposerSend>["onSend"] | undefined;
    let resume: ReturnType<typeof useComposerResume>["onResume"] | undefined;
    let intake:
      | ReturnType<typeof useComposerAttachmentIntake>["addComposerAttachments"]
      | undefined;
    let fanout: ReturnType<typeof useMultipleModelSend> | undefined;
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
      const { addComposerAttachments, removeComposerImage } = useComposerAttachmentIntake({
        environmentId,
        attachmentDraftTarget: target,
        activeThreadId: threadId,
        activePendingProgress: null,
        activePendingIsResponding: false,
        pendingUserInputs: [],
        supportsQuestionAttachments: false,
        isLiteralPendingAnswer: false,
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
        canResume: true,
        runtimeMode: "full-access",
        scrollToEnd: noop,
      });
      useLayoutEffect(() => {
        send = onSend;
        resume = onResume;
        intake = addComposerAttachments;
        removeImage = removeComposerImage;
        preparingImages = preparing;
        fanout = sendMultiple;
      }, [onSend, onResume, addComposerAttachments, removeComposerImage, preparing, sendMultiple]);
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
    if (!send || !resume || !intake || !fanout || !removeImage)
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
    targets: [{ selection, text: fixture.context.prompt }],
    sendSnapshot: {
      images: [],
      files: [],
      attachments: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      replyTo: null,
      messageText: fixture.context.prompt,
      draftText: fixture.context.prompt,
    },
    createdAt: "2026-10-20T00:00:00Z",
    attachmentsPromise: Promise.resolve([]),
    usesAttachmentUploads: false,
    readFileBlockReason: () => null,
    buildOutgoingMessageContext: () => undefined,
    isCurrentSend: () => true,
    isCurrentDraft: () =>
      fixture.route.current === fixture.input.routeThreadKey &&
      submission.composerSubmissionMatchesDraft(
        draftAtSend,
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ),
    selectedScientSkillNames: ["captured"],
    runtimeMode: "full-access",
  } satisfies Parameters<ReturnType<typeof useMultipleModelSend>>[0];
}

describe("mounted composer send admission owner", () => {
  // The command regex itself is covered in ContextWindowMeter.logic.scient.test.ts.
  // regression: f6e88b251e chore(upstream): merge official T3 through 9a391eb3f5
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

  it.each(["/fork"])(
    "runs the local %s command without declining a shown feedback request",
    async (prompt) => {
      const requestId = RuntimeRequestId.make("local-command-feedback");
      const respond = vi.fn();
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
        onForkConversation,
      });
      fixture.context = { ...fixture.context, prompt, shownPendingApprovalIds: [requestId] };
      fixture.input.promptRef.current = prompt;
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      await fixture.send();
      expect(respond).not.toHaveBeenCalled();
      expect(fixture.command).not.toHaveBeenCalled();
      expect(onForkConversation).toHaveBeenCalledTimes(1);
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
    // The send waits for the image; removing its tile cancels the held send.
    const sending = fixture.send();
    expect(fixture.command).not.toHaveBeenCalled();
    const imageId = fixture.preparingImages[0]!.id;
    await act(() => fixture.removeImage(imageId));
    await sending;
    expect(fixture.command).not.toHaveBeenCalled();
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
  it.each(["stays", "leaves"] as const)(
    "a send made while an image compresses waits and sends it when the user %s",
    async (route) => {
      await using fixture = await setup();
      const converted =
        Promise.withResolvers<
          Awaited<ReturnType<typeof imageCompression.prepareImageForAttachment>>
        >();
      vi.mocked(imageCompression.prepareImageForAttachment).mockImplementationOnce(
        () => converted.promise,
      );
      const image = new File(["image"], "shot.png", { type: "image/png" });
      let adding!: Promise<boolean>;
      await act(() => {
        adding = fixture.intake([image]);
      });
      const targetKey = composerTargetKey(fixture.input.composerDraftTarget);
      expect(countPreparingComposerImages(targetKey)).toBe(1);
      const sending = fixture.send();
      // The send holds until the compressed image joins the draft.
      await act(async () => {});
      expect(fixture.command).not.toHaveBeenCalled();
      if (route === "leaves") fixture.route.current = "another-route";
      converted.resolve({ ok: true, file: image, recompressed: false });
      await adding;
      await sending;
      expect(fixture.command).toHaveBeenCalledTimes(1);
      expect(fixture.command.mock.calls[0]?.[0].input.message.attachments).toHaveLength(1);
    },
  );

  it("a post to the people in a thread waits for a compressing image", async () => {
    const posted: Array<{ readonly prompt: string | undefined; readonly images: number }> = [];
    const target = { current: undefined as ComposerSendInput["composerDraftTarget"] | undefined };
    using _room = vi.spyOn(roomComposer, "useRoomComposerPost").mockReturnValue({
      applies: () => true,
      post: async (options) => {
        const draft = useComposerDraftStore.getState().getComposerDraft(target.current!);
        posted.push({ prompt: options?.prompt, images: draft?.images.length ?? 0 });
      },
    });
    await using fixture = await setup();
    target.current = fixture.input.composerDraftTarget;
    const converted =
      Promise.withResolvers<
        Awaited<ReturnType<typeof imageCompression.prepareImageForAttachment>>
      >();
    vi.mocked(imageCompression.prepareImageForAttachment).mockImplementationOnce(
      () => converted.promise,
    );
    const image = new File(["image"], "shot.png", { type: "image/png" });
    let adding!: Promise<boolean>;
    await act(() => {
      adding = fixture.intake([image]);
    });
    fixture.input.promptRef.current = "look at this";
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "look at this");
    const sending = fixture.send();
    await act(async () => {});
    expect(posted).toEqual([]);
    converted.resolve({ ok: true, file: image, recompressed: false });
    await adding;
    await sending;
    expect(posted).toEqual([{ prompt: "look at this", images: 1 }]);
    expect(fixture.command).not.toHaveBeenCalled();
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
  it("holds one admission lock and keeps settings and skills captured before the send yields", async () => {
    await using fixture = await setup();
    using held = heldSubmissionIdentity();
    const first = fixture.send();
    await vi.waitFor(() => expect(held.identify).toHaveBeenCalledTimes(1));
    await fixture.send();
    expect(held.identify).toHaveBeenCalledTimes(1);
    fixture.context = {
      ...fixture.context,
      prompt: "$later Different prompt",
      selectedModel: "later-model",
      selectedModelSelection: {
        ...fixture.context.selectedModelSelection,
        model: "later-model",
      },
    };
    held.resolve("qitem_held");
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
    "cancels before dispatch when %s while the send prepares",
    async (change) => {
      await using fixture = await setup();
      using held = heldSubmissionIdentity();
      const sending = fixture.send();
      await vi.waitFor(() => expect(held.identify).toHaveBeenCalledTimes(1));
      if (change === "draft changed")
        useComposerDraftStore
          .getState()
          .setPrompt(fixture.input.composerDraftTarget, "Newer draft");
      else fixture.route.current = "another-route";
      const draft = useComposerDraftStore
        .getState()
        .getComposerDraft(fixture.input.composerDraftTarget);
      held.resolve("qitem_held");
      await sending;
      expect(fixture.command).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
      ).toBe(draft);
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
    },
  );

  // SCIENT-FORK:START — `/feedback` opens Send feedback to Scient and never reaches the model.
  const withScientFeedback = async (run: () => Promise<void>) => {
    const host = window as unknown as { desktopBridge?: object };
    const bridge = host.desktopBridge;
    host.desktopBridge = { ...bridge, feedback: {} };
    useFeedbackDraft.setState({ open: false, message: "" });
    try {
      await run();
    } finally {
      if (bridge === undefined) delete host.desktopBridge;
      else host.desktopBridge = bridge;
    }
  };

  it("opens Send feedback to Scient with the words after /feedback", async () => {
    await withScientFeedback(async () => {
      await using fixture = await setup();
      const prompt = "/feedback the export lost my figures";
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      fixture.context = { ...fixture.context, prompt };
      await fixture.send();
      expect(fixture.command).not.toHaveBeenCalled();
      expect(useFeedbackDraft.getState()).toMatchObject({
        open: true,
        source: "slash-command",
        message: "the export lost my figures",
      });
    });
  });

  it("refuses /feedback with an attachment instead of sending it to the model", async () => {
    await withScientFeedback(async () => {
      const toast = vi.spyOn(toastManager, "add");
      await using fixture = await setup();
      const prompt = "/feedback the export failed";
      useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
      fixture.context = {
        ...fixture.context,
        prompt,
        files: [
          {
            type: "file",
            id: "figure",
            name: "figure.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
            file: new File(["pdf"], "figure.pdf", { type: "application/pdf" }),
          },
        ],
      };
      await fixture.send();
      expect(fixture.command).not.toHaveBeenCalled();
      expect(useFeedbackDraft.getState().open).toBe(false);
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Remove the attachments to send feedback" }),
      );
      toast.mockRestore();
    });
  });
  // SCIENT-FORK:END

  // Send is enabled for a composer that holds only a thread context, so the send must go.
  it("sends a message whose only content is an attached thread", async () => {
    await using fixture = await setup();
    const attached = threadContextRecord(
      scopeThreadRef(fixture.input.environmentId, ThreadId.make("attached")),
      "Attached",
    );
    const prompt = formatInlineContextReference(threadContextReference(attached));
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
    fixture.context = { ...fixture.context, prompt, threadContexts: [attached] };
    await fixture.send();
    expect(
      fixture.command,
      JSON.stringify(vi.mocked(fixture.input.setThreadError).mock.calls),
    ).toHaveBeenCalledTimes(1);
  });

  it("sends a direct steer without consuming the unrelated composer draft or files", async () => {
    const queuedRunEdit = queuedRunEditStub({ isEditing: true });
    await using fixture = await setup({ queuedRunEdit });
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
    // The queued message open in the composer is not saved by a direct prompt.
    expect(queuedRunEdit.saveEdit).not.toHaveBeenCalled();
  });

  it("saves the queued message being edited, with its mentions and reply, instead of sending", async () => {
    const queuedRunEdit = queuedRunEditStub({ isEditing: true });
    await using fixture = await setup({ queuedRunEdit });
    const attached = threadContextRecord(
      scopeThreadRef(fixture.input.environmentId, ThreadId.make("attached")),
      "Attached",
    );
    const reply = responseContextRecord({
      citation: {
        version: 1,
        environmentId: fixture.input.environmentId,
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("answer"),
        text: "The earlier answer",
        start: 0,
        end: 18,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("answer-item"),
      subagents: [],
    });
    const prompt = `Look at ${formatInlineContextReference(threadContextReference(attached))}`;
    const target = fixture.input.composerDraftTarget;
    useComposerDraftStore.getState().setPrompt(target, prompt);
    useComposerDraftStore.getState().setReplyTo(target, reply);
    fixture.input.promptRef.current = prompt;
    fixture.context = { ...fixture.context, prompt, threadContexts: [attached] };
    await fixture.send(undefined, "steer", "alternate");
    expect(fixture.command).not.toHaveBeenCalled();
    expect(queuedRunEdit.saveEdit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: expect.stringContaining(prompt),
        threadContexts: [attached],
        replyTo: reply,
      }),
      fixture.input.setThreadError,
      { dispatchMode: "steer", submissionIntent: "alternate" },
    );
  });

  it("refuses to save a queued message as a side chat", async () => {
    const queuedRunEdit = queuedRunEditStub({ isEditing: true });
    await using fixture = await setup({ queuedRunEdit, onSideChat: async () => true });
    using toast = vi.spyOn(toastManager, "add");
    const prompt = "/side check this";
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, prompt);
    fixture.input.promptRef.current = prompt;
    fixture.context = { ...fixture.context, prompt };
    await fixture.send();
    expect(queuedRunEdit.saveEdit).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Queued message not updated" }),
    );
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
  it("keeps a newer draft when an ordinary acknowledgement arrives late", async () => {
    await using fixture = await setup({});
    const admitted = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
    fixture.command.mockImplementationOnce(() => {
      admitted.resolve();
      return receipt.promise;
    });
    const sending = fixture.send();
    await admitted.promise;
    useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "Newer question");
    const newerDraft = useComposerDraftStore
      .getState()
      .getComposerDraft(fixture.input.composerDraftTarget);
    receipt.resolve(AsyncResult.success({ queued: false }));
    await sending;
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget)?.prompt,
    ).toBe("Newer question");
    expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget),
    ).toBe(newerDraft);
  });

  it.each(["empty composer", "newer draft"] as const)(
    "clears the draft as the message shows and returns a failed send: %s",
    async (meanwhile) => {
      await using fixture = await setup({});
      const dispatched = Promise.withResolvers<void>();
      const receipt = Promise.withResolvers<AtomCommandResult<{ queued: boolean }, unknown>>();
      fixture.command.mockImplementationOnce(() => {
        dispatched.resolve();
        return receipt.promise;
      });
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("synthetic-failed-send-toast");
      const draftOf = () =>
        useComposerDraftStore.getState().getComposerDraft(fixture.input.composerDraftTarget);
      const sending = fixture.send();
      await dispatched.promise;
      expect(draftOf()?.prompt ?? "").toBe("");
      if (meanwhile === "newer draft")
        useComposerDraftStore
          .getState()
          .setPrompt(fixture.input.composerDraftTarget, "Newer question");
      const newerDraft = draftOf();
      const failed = await settlePromise(async () => {
        throw new Error("Synthetic rejection");
      });
      if (failed._tag !== "Failure") throw new Error("Expected synthetic failure");
      receipt.resolve(failed);
      await sending;
      if (meanwhile === "empty composer") {
        expect(draftOf()?.prompt).toBe("$captured Please investigate");
        expect(toast).not.toHaveBeenCalled();
      } else {
        expect(draftOf()).toBe(newerDraft);
        expect(toast).toHaveBeenCalledOnce();
        useComposerDraftStore.getState().setPrompt(fixture.input.composerDraftTarget, "");
        // An unmounted composer leaves its route ref behind; recovery must not depend on it.
        fixture.route.current = "unmounted";
        const recovery = toast.mock.calls[0]![0] as { actionProps: { onClick: () => void } };
        recovery.actionProps.onClick();
        expect(draftOf()?.prompt).toBe("$captured Please investigate");
      }
      expect(draftSendState(fixture.input.routeThreadKey).sendInFlight.current).toBe(false);
    },
  );

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
});
