import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { RevertConfirmHost } from "../../components/chat/ChatOverlayHosts";
import { retainThreadOverlaysForThread } from "../../components/chat/threadOverlayRetention";
import { useTimelineRewind } from "../../components/chat/useTimelineRewind";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { ChatMessage } from "../../types";
import { ScientRevertDialogDiagnostics } from "./ScientRevertDialogDiagnostics";

const environmentId = EnvironmentId.make("environment-edit-from-here");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-edit-from-here"));
const threadKey = "thread-edit-from-here";
const messageId = MessageId.make("message-2");
const createdAt = "2026-11-21T00:00:00Z";
const message: ChatMessage = {
  id: messageId,
  role: "user",
  text: "Plot the second run",
  runId: null,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
  inputIntent: "turn_start",
};

const mocks = vi.hoisted(() => ({
  revertThreadCheckpoint: vi.fn(),
  waitForRevertedMessage: vi.fn(),
  readPreparedConnection: vi.fn(),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  readPreparedConnection: ((...args: unknown[]) => mocks.readPreparedConnection(...args)) as never,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({})) as never,
}));
vi.mock(import("../../components/ChatView.logic"), async (original) => ({
  ...(await original()),
  prepareRevertedMessageAttachments: async () => [],
  waitForRevertedMessage: ((...args: unknown[]) => mocks.waitForRevertedMessage(...args)) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => mocks.revertThreadCheckpoint) as never,
}));
vi.mock(import("../../state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => async () => "") as never,
}));

const run = (ordinal: number) => ({ id: `run-${ordinal}`, ordinal, status: "completed" });
const checkpoint = (ordinal: number, files: ReadonlyArray<string>) => ({
  id: `checkpoint-${ordinal}`,
  scopeId: "scope-root",
  runId: `run-${ordinal}`,
  ordinalWithinScope: ordinal,
  appRunOrdinal: ordinal,
  status: "ready",
  files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 1 })),
});
// The message started run 2; editing it rewinds to after run 1.
const threadWhereRun2Changed = (files: ReadonlyArray<string>) =>
  ({
    runs: [run(1), run(2)],
    checkpoints: [checkpoint(1, ["setup.py"]), checkpoint(2, files)],
    checkpointScopes: [{ id: "scope-root" }],
  }) as unknown as ThreadStructure;

function Harness(props: {
  readonly projection: ThreadStructure;
  readonly composer: Pick<
    ChatComposerHandle,
    "resetCursorState" | "focusAtEnd" | "hasPendingAttachments"
  >;
}) {
  const composerRef = useRef(props.composer as ChatComposerHandle);
  const promptRef = useRef("");
  const currentRouteThreadKeyRef = useRef<string | null>(threadKey);
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(threadKey),
  );
  const { onConfirmRevertStable, onRevertTimelineTurnStable } = useTimelineRewind({
    hasProjectWorkspace: true,
    environmentId,
    routeThreadRef: threadRef,
    routeThreadKey: threadKey,
    currentRouteThreadKeyRef,
    serverProjection: props.projection,
    activeThread: { id: threadRef.threadId } as never,
    timelineMessages: [message],
    phase: "ready",
    isSendBusy: false,
    isRevertingCheckpoint,
    supportsConversationRollback: true,
    activeEnvironmentUnavailable: false,
    activeEnvironmentUnavailableLabel: null,
    promptRef,
    composerRef,
    composerDraftTarget: threadRef,
    setThreadError: vi.fn(),
  });
  return (
    <>
      <button type="button" onClick={() => onRevertTimelineTurnStable(1, messageId)}>
        Edit from here
      </button>
      <RevertConfirmHost
        threadKey={threadKey}
        environmentId={environmentId}
        taskFolderPath={null}
        projection={props.projection}
        worktreePath="/worktree"
        onConfirm={onConfirmRevertStable}
        reverting={isRevertingCheckpoint}
        renderDetails={(error) => (
          <ScientRevertDialogDiagnostics fileHistoryIssue={null} error={error} />
        )}
      />
    </>
  );
}

function setup() {
  const stack = new DisposableStack();
  const draftsBefore = useComposerDraftStore.getState();
  stack.defer(() => useComposerDraftStore.setState(draftsBefore, true));
  retainThreadOverlaysForThread(null);
  stack.defer(() => retainThreadOverlaysForThread(null));
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Synthetic environment",
    httpBaseUrl: "http://edit-from-here.invalid",
    wsBaseUrl: "ws://edit-from-here.invalid",
  });
  mocks.readPreparedConnection.mockReset();
  mocks.readPreparedConnection.mockReturnValue({
    environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: "ws://edit-from-here.invalid/ws",
    httpAuthorization: null,
    target,
  });
  mocks.revertThreadCheckpoint.mockReset();
  mocks.revertThreadCheckpoint.mockResolvedValue(AsyncResult.success(undefined));
  mocks.waitForRevertedMessage.mockReset();
  mocks.waitForRevertedMessage.mockImplementation(
    async (_thread: unknown, _count: unknown, _id: unknown, revert: () => Promise<void>) => {
      await revert();
      return [];
    },
  );
  const composer = {
    resetCursorState: vi.fn(),
    focusAtEnd: vi.fn(),
    hasPendingAttachments: () => false,
  };
  return { composer, [Symbol.dispose]: () => stack.dispose() };
}

const renderHarness = (
  projection: ThreadStructure,
  composer: ReturnType<typeof setup>["composer"],
) =>
  render(
    <AppAtomRegistryProvider>
      <Harness projection={projection} composer={composer} />
    </AppAtomRegistryProvider>,
    { router: false },
  );

const editFromHere = () => userEvent.click(page.getByRole("button", { name: "Edit from here" }));
const dialog = () => page.getByRole("alertdialog");

describe("Edit from here", () => {
  it("rewinds without asking when no later turn changed files", async () => {
    using fixture = setup();
    await using _screen = await renderHarness(threadWhereRun2Changed([]), fixture.composer);
    await editFromHere();
    await vi.waitFor(() =>
      expect(fixture.composer.resetCursorState).toHaveBeenCalledWith({
        prompt: message.text,
        cursor: message.text.length,
      }),
    );
    expect(mocks.revertThreadCheckpoint).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: expect.objectContaining({ turnCount: 1, restoreFiles: false }),
    });
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(message.text);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("asks first when a later turn changed files", async () => {
    using fixture = setup();
    await using _screen = await renderHarness(
      threadWhereRun2Changed(["figure.png"]),
      fixture.composer,
    );
    await editFromHere();
    await expect.element(dialog()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Revert files too" })).toBeEnabled();
    expect(mocks.revertThreadCheckpoint).not.toHaveBeenCalled();
  });

  it("opens the dialog with the failure when the direct rewind fails", async () => {
    using fixture = setup();
    mocks.waitForRevertedMessage.mockRejectedValue(new Error("checkpoint ref missing"));
    await using _screen = await renderHarness(threadWhereRun2Changed([]), fixture.composer);
    await editFromHere();
    await expect.element(dialog()).toBeVisible();
    await expect.element(dialog().getByRole("alert")).toBeVisible();
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
      "checkpoint ref missing",
    );
    await expect
      .element(page.getByRole("button", { name: "Revert and keep changes" }))
      .toBeEnabled();
    expect(fixture.composer.resetCursorState).not.toHaveBeenCalled();
  });
});
