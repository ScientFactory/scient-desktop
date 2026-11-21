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
  prepareRevertedMessageAttachments: vi.fn(),
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
  prepareRevertedMessageAttachments: ((...args: unknown[]) =>
    mocks.prepareRevertedMessageAttachments(...args)) as never,
  waitForRevertedMessage: ((...args: unknown[]) => mocks.waitForRevertedMessage(...args)) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => mocks.revertThreadCheckpoint) as never,
}));
vi.mock(import("../../state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => async () => "") as never,
}));

const run = (ordinal: number) => ({ id: `run-${ordinal}`, ordinal, status: "completed" });
const checkpoint = (ordinal: number, files: ReadonlyArray<string>, changesKnown = true) => ({
  id: `checkpoint-${ordinal}`,
  scopeId: "scope-root",
  runId: `run-${ordinal}`,
  ordinalWithinScope: ordinal,
  appRunOrdinal: ordinal,
  status: "ready",
  files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 1 })),
  ...(changesKnown ? { changesKnown: true } : {}),
});
// The message started run 2; editing it rewinds to after run 1.
const threadAfterRun2 = (later: ReadonlyArray<ReturnType<typeof checkpoint>>) =>
  ({
    runs: [run(1), ...later.map((entry) => run(entry.ordinalWithinScope))],
    checkpoints: [checkpoint(1, ["setup.py"]), ...later],
    checkpointScopes: [{ id: "scope-root" }],
  }) as unknown as ThreadStructure;
const unchangedAfterRun1 = threadAfterRun2([checkpoint(2, [])]);

function Harness(props: {
  readonly projection: ThreadStructure;
  readonly worktreePath: string | null;
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
    activeThread: { id: threadRef.threadId, worktreePath: props.worktreePath } as never,
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
        taskFolderPath={props.worktreePath}
        projection={props.projection}
        worktreePath={props.worktreePath}
        onConfirm={onConfirmRevertStable}
        reverting={isRevertingCheckpoint}
        describeUnrestorableFiles={() => "Files stay as they are."}
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
  mocks.prepareRevertedMessageAttachments.mockReset();
  mocks.prepareRevertedMessageAttachments.mockResolvedValue([]);
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

const PROJECT_FOLDER = null;
const WORKTREE = "/worktree";

const harness = (
  projection: ThreadStructure,
  worktreePath: string | null,
  composer: ReturnType<typeof setup>["composer"],
) => (
  <AppAtomRegistryProvider>
    <Harness projection={projection} worktreePath={worktreePath} composer={composer} />
  </AppAtomRegistryProvider>
);
const renderHarness = (...args: Parameters<typeof harness>) =>
  render(harness(...args), { router: false });

const editFromHere = () => userEvent.click(page.getByRole("button", { name: "Edit from here" }));
const dialog = () => page.getByRole("alertdialog");

describe("Edit from here", () => {
  it("rewinds a project-folder thread without asking when no later turn changed files", async () => {
    using fixture = setup();
    await using _screen = await renderHarness(unchangedAfterRun1, PROJECT_FOLDER, fixture.composer);
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

  it("asks in a worktree thread, where files can be reverted, even when nothing changed", async () => {
    using fixture = setup();
    await using _screen = await renderHarness(unchangedAfterRun1, WORKTREE, fixture.composer);
    await editFromHere();
    await expect.element(dialog()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Revert files too" })).toBeEnabled();
    expect(mocks.prepareRevertedMessageAttachments).not.toHaveBeenCalled();
    expect(mocks.revertThreadCheckpoint).not.toHaveBeenCalled();
  });

  it("asks when the server could not tell what a later turn changed", async () => {
    using fixture = setup();
    await using _screen = await renderHarness(
      threadAfterRun2([checkpoint(2, [], false)]),
      PROJECT_FOLDER,
      fixture.composer,
    );
    await editFromHere();
    await expect.element(dialog()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Rewind chat" })).toBeEnabled();
    expect(mocks.revertThreadCheckpoint).not.toHaveBeenCalled();
  });

  it("asks instead when a turn that changed files finished while attachments were prepared", async () => {
    using fixture = setup();
    const prepared = Promise.withResolvers<File[]>();
    mocks.prepareRevertedMessageAttachments.mockReturnValue(prepared.promise);
    await using screen = await renderHarness(unchangedAfterRun1, PROJECT_FOLDER, fixture.composer);
    await editFromHere();
    await vi.waitFor(() => expect(mocks.prepareRevertedMessageAttachments).toHaveBeenCalled());
    await screen.rerender(
      harness(
        threadAfterRun2([checkpoint(2, []), checkpoint(3, ["results.csv"])]),
        PROJECT_FOLDER,
        fixture.composer,
      ),
    );
    prepared.resolve([]);
    await expect.element(dialog()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Rewind chat" })).toBeEnabled();
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')).toBeNull();
    expect(mocks.revertThreadCheckpoint).not.toHaveBeenCalled();
    expect(fixture.composer.resetCursorState).not.toHaveBeenCalled();
  });

  it("opens the dialog with the failure when the direct rewind fails", async () => {
    using fixture = setup();
    mocks.waitForRevertedMessage.mockRejectedValue(new Error("checkpoint ref missing"));
    await using _screen = await renderHarness(unchangedAfterRun1, PROJECT_FOLDER, fixture.composer);
    await editFromHere();
    await expect.element(dialog()).toBeVisible();
    await expect.element(dialog().getByRole("alert")).toBeVisible();
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
      "checkpoint ref missing",
    );
    await expect.element(page.getByRole("button", { name: "Rewind chat" })).toBeEnabled();
    expect(fixture.composer.resetCursorState).not.toHaveBeenCalled();
  });
});
