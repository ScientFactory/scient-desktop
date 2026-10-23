import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect } from "react";

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, MessageId, ThreadId, RunId } from "@t3tools/contracts";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ dispatch: vi.fn(), options: vi.fn(), panels: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label.endsWith(":fork-options") ? commands.options : commands.dispatch,
}));
vi.mock("./forkViewContinuity", async (original) => ({
  ...(await original<typeof import("./forkViewContinuity")>()),
  stageForkViewContinuity: commands.panels,
}));

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

const navigate = vi.fn(async () => {});

function Probe({ _fixture, thread }: { thread: typeof origin } & { _fixture: _Fixture }) {
  const value = useScientThreadFork({ origin: thread, navigate, supportsRecovery: true });
  useLayoutEffect(() => {
    _fixture.publishHook(value);
  });
  return null;
}
async function render(_fixture: _Fixture, thread = origin, key = "probe") {
  await act(
    async () =>
      await _fixture.root0.rerender(<Probe _fixture={_fixture} thread={thread} key={key} />),
  );
}
async function _setupFixture0(_fixture: _Fixture) {
  localStorage.clear();

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
  _fixture.container = document.createElement("div");
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.unstubAllGlobals();
}

describe("fork lifecycle across navigation and remounts", () => {
  it("submits from the checked menu without checking again, but rechecks the latest response", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => _fixture.hook.prepareFork(source));
    expect(commands.options).toHaveBeenCalledTimes(1);
    await act(async () => {
      await _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(1);
    expect(commands.dispatch).toHaveBeenCalledTimes(1);
    // The menu's check is used once: another fork from the same point checks again.
    await act(async () => {
      await _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(2);
    const latest = { kind: "assistant-response" as const, messageId: null, latest: true };
    await act(() => _fixture.hook.prepareFork(latest));
    await act(async () => {
      await _fixture.hook.forkFromMessage(latest, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(4);
  });

  it("reuses the options of the menu shown, not a stale earlier check", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const other = { kind: "assistant-response" as const, messageId: MessageId.make("other") };
    const resolved = (messageId: MessageId) =>
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        newWorktree: false,
        sourceAssistantMessageId: messageId,
        sourceUserMessageId: null,
      });
    let finishSlow!: () => void;
    commands.options
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSlow = () => resolve(resolved(other.messageId));
          }),
      )
      .mockImplementationOnce(async () => resolved(source.messageId));
    await render(_fixture);
    let slow!: Promise<void>;
    await act(async () => {
      slow = _fixture.hook.prepareFork(other);
      await _fixture.hook.prepareFork(source);
    });
    await act(async () => {
      finishSlow();
      await slow;
    });
    await act(async () => {
      await _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
    });
    expect(commands.options).toHaveBeenCalledTimes(2);
    expect(commands.dispatch).toHaveBeenCalledTimes(1);
  });

  it("checks again when the menu's options are older than 30 seconds", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await render(_fixture);
      await act(() => _fixture.hook.prepareFork(source));
      now.mockReturnValue(1_000_000 + 30_001);
      await act(async () => {
        await _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
      });
      expect(commands.options).toHaveBeenCalledTimes(2);
      expect(commands.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it.each([true, false])(
    "dispatches a missing-image fork only after confirmation (%s)",
    async (proceed) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

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
      await render(_fixture);
      let outcome: unknown;
      await act(async () => {
        outcome = await _fixture.hook.forkFromMessage(
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      let release!: (value: unknown) => void;
      commands.dispatch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      useComposerDraftStore.getState().setPrompt(sourceRef, "Unsent provider-switch draft");
      await render(_fixture);
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = _fixture.hook.forkFromMessage(source, options, "/workspace");
      });
      _fixture.cleanup.defer(async () => {
        release?.(AsyncResult.success({ sequence: 42 }));
        await pending;
      });
      await vi.waitFor(() => expect(commands.dispatch).toHaveBeenCalledOnce());
      expect(_fixture.hook.isForking).toBe(true);
      const firstCommand = commands.dispatch.mock.calls[0]![0].input;
      await render(_fixture, nextOrigin);
      expect(_fixture.hook.isForking).toBe(false);
      await act(async () => {
        release(AsyncResult.success({ sequence: 42 }));
        await pending;
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(sourceRef)]?.prompt,
      ).toBe("Unsent provider-switch draft");

      await render(_fixture);
      await act(() => _fixture.hook.prepareFork(source));
      expect(_fixture.hook.preview?.locked).toBe(true);
      await act(() => _fixture.hook.forkFromMessage(source, options, "/workspace"));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(request, { workspaceMode: "local" }, "/workspace"),
    );
    const first = commands.dispatch.mock.calls[0]![0].input;
    const destination = scopeThreadRef(environmentId, first.newThreadId);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe(request.prompt);
    await render(_fixture, origin, "remounted");
    await act(() =>
      _fixture.hook.forkFromMessage(
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

  it("shows a removed worktree's project-folder notice again when a kept fork is retried", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const notice = "The original worktree was removed, so this fork works in the project folder.";
    commands.options.mockResolvedValue(
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        workspaceNotice: notice,
        newWorktree: false,
        sourceAssistantMessageId: source.messageId,
        sourceUserMessageId: null,
      }),
    );
    commands.dispatch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Connection lost"))),
    );
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace"),
    );
    commands.options.mockClear();
    await render(_fixture, origin, "remounted");
    await act(() => _fixture.hook.prepareFork(source));
    expect(_fixture.hook.preview?.locked).toBe(true);
    expect(commands.options).not.toHaveBeenCalled();
    expect(_fixture.hook.preview?.options?.workspaceNotice).toBe(notice);
  });

  it("opens the fork on its own after the request lost its connection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    try {
      commands.dispatch.mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new ConnectionTransientError({ reason: "transport", detail: "Server disconnected." }),
          ),
        ),
      );
      await render(_fixture);
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace");
      });
      await vi.waitFor(() => expect(commands.dispatch).toHaveBeenCalledOnce());
      expect(_fixture.hook.isForking).toBe(true);
      expect(_fixture.hook.errorUpdate).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORK_RECONNECT_DELAYS_MS[0]!);
        await pending;
      });

      expect(commands.dispatch).toHaveBeenCalledTimes(2);
      expect(commands.dispatch.mock.calls[1]![0].input).toEqual(
        commands.dispatch.mock.calls[0]![0].input,
      );
      expect(_fixture.hook.errorUpdate).toBeNull();
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the fork point an error is about, so another point's dialog does not show it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    commands.dispatch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("The workspace could not be prepared."))),
    );
    await render(_fixture);
    await act(() => _fixture.hook.prepareFork(source));
    const failedKey = _fixture.hook.preview?.key;
    await act(() =>
      _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace"),
    );
    expect(_fixture.hook.errorUpdate?.message).toContain("The workspace could not be prepared.");
    expect(_fixture.hook.errorUpdate?.key).toBe(failedKey);

    await act(() =>
      _fixture.hook.prepareFork({
        kind: "assistant-response",
        messageId: MessageId.make("other-answer"),
      }),
    );
    expect(_fixture.hook.preview?.key).not.toBe(failedKey);
    expect(_fixture.hook.errorUpdate).toBeNull();
  });

  it("does not move a draft edited while the fork request was in flight", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let release!: (value: unknown) => void;
    commands.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Original draft");
    await render(_fixture);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = _fixture.hook.forkFromMessage(source, options, "/workspace");
    });
    _fixture.cleanup.defer(async () => {
      release?.(AsyncResult.success({ sequence: 42 }));
      await pending;
    });
    await vi.waitFor(() => expect(commands.dispatch).toHaveBeenCalledOnce());
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let release!: (value: unknown) => void;
    commands.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Source draft");
    await render(_fixture);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = _fixture.hook.forkFromMessage(source, options, "/workspace");
    });
    _fixture.cleanup.defer(async () => {
      release?.(AsyncResult.success({ sequence: 42 }));
      await pending;
    });
    await vi.waitFor(() => expect(commands.dispatch).toHaveBeenCalledOnce());
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finishExit!: (completed: boolean) => void;
    const beforeNavigate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishExit = resolve;
        }),
    );
    useComposerDraftStore.getState().setPrompt(sourceRef, "Keep visible until the card closes");
    await render(_fixture);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = _fixture.hook.forkFromMessage(source, { ...options, beforeNavigate }, "/workspace");
    });
    _fixture.cleanup.defer(async () => {
      finishExit?.(false);
      await pending;
    });
    await vi.waitFor(() => expect(beforeNavigate).toHaveBeenCalledOnce());
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finishExit!: (completed: boolean) => void;
    await render(_fixture);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = _fixture.hook.forkFromMessage(
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
    _fixture.cleanup.defer(async () => {
      finishExit?.(false);
      await pending;
    });
    await vi.waitFor(() => expect(finishExit).toBeTypeOf("function"));
    await render(_fixture, other);
    await act(async () => {
      finishExit(true);
      await pending;
    });
    expect(navigate).not.toHaveBeenCalled();
    await render(_fixture);
    await act(() => _fixture.hook.forkFromMessage(source, options, "/workspace"));
    expect(commands.dispatch).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled exit recoverable without another fork command", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(
        source,
        { ...options, beforeNavigate: async () => false },
        "/workspace",
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(_fixture.hook.isForking).toBe(false);
    await act(() => _fixture.hook.forkFromMessage(source, options, "/workspace"));
    expect(commands.dispatch).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("uses the server's completed boundary for the latest-response entry point", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(
        { ...source, latest: true },
        { workspaceMode: "local" },
        "/workspace",
      ),
    );
    expect(commands.options.mock.calls[0]![0].input).toEqual({ originThreadId: origin.id });
    expect(commands.dispatch.mock.calls[0]![0].input.sourceAssistantMessageId).toBe(completed);
  });

  it("forks a running turn with its work in progress", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(
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

function _createFixture() {
  let _published_hook = undefined! as ReturnType<typeof useScientThreadFork>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get hook() {
      return _published_hook;
    },
    publishHook(next: typeof _published_hook) {
      _published_hook = next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
