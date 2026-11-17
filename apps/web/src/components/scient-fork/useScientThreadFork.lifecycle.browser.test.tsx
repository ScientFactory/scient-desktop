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

const commands = vi.hoisted(() => ({
  dispatch: vi.fn(),
  options: vi.fn(),
  ready: vi.fn(),
  panels: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label.endsWith(":fork-options")
      ? commands.options
      : command.label.endsWith(":await-fork")
        ? commands.ready
        : commands.dispatch,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));
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
const options = { workspaceMode: "local" as const, composerDraftSource: sourceRef };

const navigate = vi.fn(async () => {});

function Probe({ _fixture, thread }: { thread: typeof origin } & { _fixture: _Fixture }) {
  const value = useScientThreadFork({ origin: thread, navigate, supported: _fixture.supported });
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
  commands.ready.mockReset().mockResolvedValue(AsyncResult.success({ forkAttachmentIdMap: {} }));
  commands.toast.mockReset();
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
        const id = commands.dispatch.mock.calls[0]![0].input.targetThreadId;
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
      await act(() => _fixture.hook.forkFromMessage(source, options, "/workspace"));
      expect(commands.dispatch).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: firstCommand.targetThreadId },
      });
      const destination = scopeThreadRef(environmentId, firstCommand.targetThreadId);
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
    const destination = scopeThreadRef(environmentId, first.targetThreadId);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe(request.prompt);
    await render(_fixture, origin, "remounted");
    await act(() =>
      _fixture.hook.forkFromMessage(request, { workspaceMode: "new-worktree" }, "/workspace"),
    );
    expect(commands.dispatch.mock.calls[1]![0].input).toEqual(first);
    expect(navigate).toHaveBeenCalledOnce();
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(destination)]?.prompt,
    ).toBe(request.prompt);
  });

  it("says a removed worktree's fork works in the project folder, also after a retry", async () => {
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
    commands.toast.mockClear();
    await render(_fixture, origin, "remounted");
    await act(() =>
      _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace"),
    );
    // The kept attempt resumes with its saved command and notice; nothing is checked again.
    expect(commands.options).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(commands.toast).toHaveBeenCalledWith(expect.objectContaining({ description: notice }));
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORK_RECONNECT_DELAYS_MS[0]!);
        await pending;
      });

      expect(commands.dispatch).toHaveBeenCalledTimes(2);
      expect(commands.dispatch.mock.calls[1]![0].input).toEqual(
        commands.dispatch.mock.calls[0]![0].input,
      );
      expect(commands.toast).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
      commands.dispatch.mock.calls[0]![0].input.targetThreadId,
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
    expect(commands.dispatch.mock.calls[0]![0].input.scient.boundary).toEqual({
      kind: "assistant-response",
      messageId: completed,
    });
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
    expect(command.scient).toEqual({
      boundary: { kind: "running-turn", runId: runningTurn },
      workspaceMode: "new-worktree",
    });
  });

  it("opens a new worktree fork only once its setup is ready", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    commands.options.mockResolvedValue(
      AsyncResult.success({
        available: true,
        localAvailable: true,
        reason: null,
        newWorktree: true,
        sourceAssistantMessageId: source.messageId,
        sourceUserMessageId: null,
      }),
    );
    let ready!: (value: unknown) => void;
    commands.ready.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    await render(_fixture);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = _fixture.hook.forkFromMessage(source, { workspaceMode: "new-worktree" }, "/w");
    });
    _fixture.cleanup.defer(async () => {
      ready?.(AsyncResult.success({ forkAttachmentIdMap: {} }));
      await pending;
    });
    await vi.waitFor(() => expect(commands.ready).toHaveBeenCalledOnce());
    const command = commands.dispatch.mock.calls[0]![0].input;
    expect(commands.ready.mock.calls[0]![0].input).toEqual({ threadId: command.targetThreadId });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      ready(AsyncResult.success({ forkAttachmentIdMap: { "origin-file": "fork-file" } }));
      await pending;
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(commands.panels).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIdMap: { "origin-file": "fork-file" } }),
    );
  });

  it("discards the draft of a fork the server refused", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const request = {
      kind: "user-message" as const,
      messageId: MessageId.make("refused-user"),
      prompt: "Refused request",
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
      AsyncResult.failure(
        Cause.fail(
          Object.assign(new Error("The original conversation was deleted."), {
            commandDisposition: "rejected",
          }),
        ),
      ),
    );
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(request, { workspaceMode: "local" }, "/workspace"),
    );
    expect(Object.keys(useComposerDraftStore.getState().draftsByThreadKey)).toEqual([]);
    expect(commands.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "The original conversation was deleted.",
      }),
    );
    // A refused fork is gone: forking the same message again starts a new one.
    await act(() =>
      _fixture.hook.forkFromMessage(request, { workspaceMode: "local" }, "/workspace"),
    );
    expect(commands.dispatch.mock.calls[1]![0].input.targetThreadId).not.toBe(
      commands.dispatch.mock.calls[0]![0].input.targetThreadId,
    );
  });

  it("explains, without dispatching, that an older server cannot take this fork", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.supported = false;
    await render(_fixture);
    await act(() =>
      _fixture.hook.forkFromMessage(source, { workspaceMode: "local" }, "/workspace"),
    );
    expect(commands.dispatch).not.toHaveBeenCalled();
    expect(commands.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
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
    supported: true,
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
