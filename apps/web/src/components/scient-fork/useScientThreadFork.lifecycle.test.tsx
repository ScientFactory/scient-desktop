// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, MessageId, ThreadId, RunId } from "@t3tools/contracts";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ dispatch: vi.fn(), options: vi.fn(), panels: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label.endsWith(":fork-options") ? commands.options : commands.dispatch,
}));
vi.mock("./forkViewContinuity", () => ({ stageForkViewContinuity: commands.panels }));

import { useComposerDraftStore } from "~/composerDraftStore";
import { FORK_RECONNECT_DELAYS_MS } from "./forkAttempt";
import { useScientThreadFork } from "./useScientThreadFork";

const environmentId = EnvironmentId.make("fork-lifecycle-env");
const origin = { id: ThreadId.make("origin"), environmentId };
const other = { id: ThreadId.make("other"), environmentId };
const source = { kind: "assistant-response" as const, messageId: MessageId.make("answer") };
const sourceRef = scopeThreadRef(environmentId, origin.id);
const options = {
  workspaceMode: "local" as const,
  displayTitle: "My fork",
  composerDraftSource: sourceRef,
};
let hook: ReturnType<typeof useScientThreadFork>;
let root: Root;
let container: HTMLDivElement;
const navigate = vi.fn(async () => {});

function Probe({ thread }: { thread: typeof origin }) {
  const value = useScientThreadFork({ origin: thread, navigate, supportsRecovery: true });
  useLayoutEffect(() => {
    hook = value;
  });
  return null;
}
async function render(thread = origin, key = "probe") {
  await act(() => root.render(<Probe thread={thread} key={key} />));
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.dispatch.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 42 }));
  commands.options.mockReset().mockResolvedValue(
    AsyncResult.success({
      available: true,
      localAvailable: true,
      reason: null,
      newWorktree: false,
      sourceAssistantMessageId: source.messageId,
      sourceUserMessageId: null,
    }),
  );
  commands.panels.mockReset();
  navigate.mockClear();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("fork lifecycle across navigation and remounts", () => {
  it("submits from the checked menu without checking again, but rechecks the latest response", async () => {
    await render();
    await act(() => hook.prepareFork(source));
    expect(commands.options).toHaveBeenCalledTimes(1);
    await act(async () => {
      await hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(1);
    expect(commands.dispatch).toHaveBeenCalledTimes(1);
    // The menu's check is used once: another fork from the same point checks again.
    await act(async () => {
      await hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(2);
    const latest = { kind: "assistant-response" as const, messageId: null, latest: true };
    await act(() => hook.prepareFork(latest));
    await act(async () => {
      await hook.forkFromMessage(latest, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])(
    "dispatches a missing-image fork only after confirmation (%s)",
    async (proceed) => {
      const userSource = {
        kind: "user-message" as const,
        messageId: MessageId.make("user-with-image"),
        prompt: "Keep exact text",
        attachments: [
          {
            type: "image" as const,
            id: "missing",
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      };
      commands.options.mockResolvedValue(
        AsyncResult.success({
          available: true,
          localAvailable: true,
          reason: null,
          newWorktree: false,
          sourceAssistantMessageId: null,
          sourceUserMessageId: userSource.messageId,
        }),
      );
      await render();
      let outcome: unknown;
      await act(async () => {
        outcome = await hook.forkFromMessage(
          userSource,
          {
            workspaceMode: "local",
            confirmSkippedImages: async (names) => {
              expect(names).toEqual(["missing.png"]);
              expect(commands.dispatch).not.toHaveBeenCalled();
              return proceed;
            },
          },
          "/workspace",
        );
      });
      expect(outcome).toBe(proceed ? "accepted" : "not-accepted");
      expect(commands.dispatch).toHaveBeenCalledTimes(proceed ? 1 : 0);
      if (proceed) {
        const id = commands.dispatch.mock.calls[0]![0].input.newThreadId;
        expect(
          useComposerDraftStore.getState().draftsByThreadKey[
            scopedThreadKey(scopeThreadRef(environmentId, id))
          ]?.prompt,
        ).toBe(userSource.prompt);
      } else expect(Object.keys(useComposerDraftStore.getState().draftsByThreadKey)).toEqual([]);
    },
  );

  it.each([other, { ...origin, environmentId: EnvironmentId.make("another-environment") }])(
    "finishes without stealing navigation after switching to %j, then opens the same ready fork",
    async (nextOrigin) => {
      let release!: (value: unknown) => void;
      commands.dispatch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      useComposerDraftStore.getState().setPrompt(sourceRef, "Unsent provider-switch draft");
      await render();
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = hook.forkFromMessage(source, options, "/workspace");
      });
      expect(hook.isForking).toBe(true);
      const firstCommand = commands.dispatch.mock.calls[0]![0].input;
      await render(nextOrigin);
      expect(hook.isForking).toBe(false);
      await act(async () => {
        release(AsyncResult.success({ sequence: 42 }));
        await pending;
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt,
      ).toBe("Unsent provider-switch draft");

      await render();
      await act(() => hook.prepareFork(source));
      expect(hook.preview?.locked).toBe(true);
      await act(() => hook.forkFromMessage(source, options, "/workspace"));
      expect(commands.dispatch).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: firstCommand.newThreadId },
      });
      const destination = scopeThreadRef(environmentId, firstCommand.newThreadId);
      expect(
        useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
      ).toBe("Unsent provider-switch draft");
    },
  );

  it("preserves the selected user draft and operation identity after transport loss and a hook remount", async () => {
    const request = {
      kind: "user-message" as const,
      messageId: MessageId.make("user"),
      prompt: "Edit this request",
      attachments: [],
    };
    commands.options.mockResolvedValue(
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        newWorktree: false,
        sourceAssistantMessageId: null,
        sourceUserMessageId: request.messageId,
      }),
    );
    commands.dispatch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Connection lost"))),
    );
    await render();
    await act(() => hook.forkFromMessage(request, { workspaceMode: "local" }, "/workspace"));
    const first = commands.dispatch.mock.calls[0]![0].input;
    const destination = scopeThreadRef(environmentId, first.newThreadId);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe(request.prompt);
    await render(origin, "remounted");
    await act(() =>
      hook.forkFromMessage(
        request,
        { workspaceMode: "new-worktree", titleOverride: "Changed during retry" },
        "/workspace",
      ),
    );
    expect(commands.dispatch.mock.calls[1]![0].input).toEqual(first);
    expect(navigate).toHaveBeenCalledOnce();
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe(request.prompt);
  });

  it("opens the fork on its own after the request lost its connection", async () => {
    vi.useFakeTimers();
    try {
      commands.dispatch.mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new ConnectionTransientError({ reason: "transport", detail: "Server disconnected." }),
          ),
        ),
      );
      await render();
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
      });
      expect(hook.isForking).toBe(true);
      expect(hook.errorUpdate).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORK_RECONNECT_DELAYS_MS[0]!);
        await pending;
      });

      expect(commands.dispatch).toHaveBeenCalledTimes(2);
      expect(commands.dispatch.mock.calls[1]![0].input).toEqual(
        commands.dispatch.mock.calls[0]![0].input,
      );
      expect(hook.errorUpdate).toBeNull();
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the fork point an error is about, so another point's dialog does not show it", async () => {
    commands.dispatch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("The workspace could not be prepared."))),
    );
    await render();
    await act(() => hook.prepareFork(source));
    const failedKey = hook.preview?.key;
    await act(() => hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace"));
    expect(hook.errorUpdate?.message).toContain("The workspace could not be prepared.");
    expect(hook.errorUpdate?.key).toBe(failedKey);

    await act(() =>
      hook.prepareFork({ kind: "assistant-response", messageId: MessageId.make("other-answer") }),
    );
    expect(hook.preview?.key).not.toBe(failedKey);
    expect(hook.errorUpdate).toBeNull();
  });

  it("does not move a draft edited while the fork request was in flight", async () => {
    let release!: (value: unknown) => void;
    commands.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Original draft");
    await render();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = hook.forkFromMessage(source, options, "/workspace");
    });
    useComposerDraftStore.getState().setPrompt(sourceRef, "New draft typed meanwhile");
    await act(async () => {
      release(AsyncResult.success({ sequence: 42 }));
      await pending;
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt,
    ).toBe("New draft typed meanwhile");
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("preserves a destination draft written before a delayed handoff", async () => {
    let release!: (value: unknown) => void;
    commands.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Source draft");
    await render();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = hook.forkFromMessage(source, options, "/workspace");
    });
    const destination = scopeThreadRef(
      environmentId,
      commands.dispatch.mock.calls[0]![0].input.newThreadId,
    );
    useComposerDraftStore.getState().setPrompt(destination, "Draft written in ready fork");
    await act(async () => {
      release(AsyncResult.success({ sequence: 42 }));
      await pending;
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt,
    ).toBe("Source draft");
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe("Draft written in ready fork");
  });

  it("finishes the card exit before transferring the draft and navigating", async () => {
    let finishExit!: (completed: boolean) => void;
    const beforeNavigate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishExit = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Keep visible until the card closes");
    await render();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = hook.forkFromMessage(source, { ...options, beforeNavigate }, "/workspace");
    });
    expect(beforeNavigate).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt,
    ).toBe("Keep visible until the card closes");
    await act(async () => {
      finishExit(true);
      await pending;
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt ?? "",
    ).toBe("");
  });

  it("does not steal navigation when the source changes during the card exit", async () => {
    let finishExit!: (completed: boolean) => void;
    await render();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = hook.forkFromMessage(
        source,
        {
          ...options,
          beforeNavigate: () =>
            new Promise((resolve) => {
              finishExit = resolve;
            }),
        },
        "/workspace",
      );
    });
    await render(other);
    await act(async () => {
      finishExit(true);
      await pending;
    });
    expect(navigate).not.toHaveBeenCalled();
    await render();
    await act(() => hook.forkFromMessage(source, options, "/workspace"));
    expect(commands.dispatch).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled exit recoverable without another fork command", async () => {
    await render();
    await act(() =>
      hook.forkFromMessage(source, { ...options, beforeNavigate: async () => false }, "/workspace"),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(hook.isForking).toBe(false);
    await act(() => hook.forkFromMessage(source, options, "/workspace"));
    expect(commands.dispatch).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("uses the server's completed boundary for the latest-response entry point", async () => {
    const completed = MessageId.make("earlier-completed-answer");
    commands.options.mockResolvedValue(
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        newWorktree: false,
        sourceAssistantMessageId: completed,
        sourceUserMessageId: null,
      }),
    );
    await render();
    await act(() =>
      hook.forkFromMessage({ ...source, latest: true }, { workspaceMode: "local" }, "/workspace"),
    );
    expect(commands.options.mock.calls[0]![0].input).toEqual({ originThreadId: origin.id });
    expect(commands.dispatch.mock.calls[0]![0].input.sourceAssistantMessageId).toBe(completed);
  });

  it("forks a running turn with its work in progress", async () => {
    const runningTurn = RunId.make("running-turn");
    commands.options.mockResolvedValue(
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        newWorktree: true,
        sourceAssistantMessageId: null,
        sourceUserMessageId: null,
        sourceRunningRunId: runningTurn,
      }),
    );
    await render();
    await act(() =>
      hook.forkFromMessage(
        { kind: "running-turn", runId: runningTurn },
        { workspaceMode: "new-worktree" },
        "/workspace",
      ),
    );
    expect(commands.options.mock.calls[0]![0].input).toEqual({
      originThreadId: origin.id,
      sourceRunningRunId: runningTurn,
    });
    const command = commands.dispatch.mock.calls[0]![0].input;
    expect(command.sourceRunningRunId).toBe(runningTurn);
    expect(command.sourceAssistantMessageId).toBeUndefined();
    expect(command.workspaceMode).toBe("new-worktree");
  });
});
