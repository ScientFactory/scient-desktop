import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import { useComposerDraftStore } from "../../composerDraftStore";
import * as logic from "../ChatView.logic";
import * as session from "../../state/session";
import { rewindToMessage } from "./chatViewSend";

function setup() {
  const stack = new DisposableStack();
  const before = useComposerDraftStore.getState();
  stack.defer(() => useComposerDraftStore.setState(before, true));
  const target = scopeThreadRef(EnvironmentId.make("rewind"), ThreadId.make("origin"));
  const connectionTarget = new PrimaryConnectionTarget({
    environmentId: target.environmentId,
    label: "Synthetic rewind environment",
    httpBaseUrl: "http://rewind.invalid",
    wsBaseUrl: "ws://rewind.invalid",
  });
  stack.use(
    vi.spyOn(session, "readPreparedConnection").mockReturnValue({
      environmentId: target.environmentId,
      label: connectionTarget.label,
      httpBaseUrl: connectionTarget.httpBaseUrl,
      socketUrl: "ws://rewind.invalid/ws",
      httpAuthorization: null,
      target: connectionTarget,
    }),
  );
  useComposerDraftStore.getState().setPrompt(target, "Keep this draft");
  const prepare = stack.use(
    vi.spyOn(logic, "prepareRevertedMessageAttachments").mockResolvedValue([]),
  );
  const wait = stack.use(
    vi
      .spyOn(logic, "waitForRevertedMessage")
      .mockImplementation(async (_thread, _count, _id, revert) => {
        await revert();
      }),
  );
  const command = vi.fn(async () => AsyncResult.success(undefined));
  const createdAt = "2026-10-20T00:00:00Z";
  const input = {
    message: {
      id: MessageId.make("user-message"),
      role: "user" as const,
      text: "Original question",
      runId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
    environmentId: target.environmentId,
    routeThreadRef: target,
    threadId: target.threadId,
    turnCount: 0,
    restoreFiles: false,
    checkpoint: undefined,
    draftTarget: target,
    composerHasPendingAttachments: false,
    isCurrentRoute: () => true,
    createAssetUrl: async () => {
      throw new Error("No attachments in this fixture");
    },
    revertThreadCheckpoint: command,
  } satisfies Parameters<typeof rewindToMessage>[0];
  return { input, prepare, wait, command, [Symbol.dispose]: () => stack.dispose() };
}

describe("rewind side-effect fences", () => {
  it.each(["draft changed", "route left"] as const)(
    "does not roll back when %s while attachments prepare",
    async (change) => {
      using fixture = setup();
      const preparing = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<File[]>();
      fixture.prepare.mockImplementation(() => {
        preparing.resolve();
        return prepared.promise;
      });
      let current = true;
      const attempt = rewindToMessage({ ...fixture.input, isCurrentRoute: () => current });
      await preparing.promise;
      if (change === "draft changed")
        useComposerDraftStore.getState().setPrompt(fixture.input.draftTarget, "Newer draft");
      else current = false;
      const draft = useComposerDraftStore.getState().getComposerDraft(fixture.input.draftTarget);
      prepared.resolve([]);
      expect(await attempt).toMatchObject({
        error: expect.stringContaining("Nothing was rewound"),
      });
      expect(fixture.command).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().getComposerDraft(fixture.input.draftTarget)).toBe(
        draft,
      );
    },
  );

  it("keeps authoring that changes while the rollback receipt settles", async () => {
    using fixture = setup();
    fixture.wait.mockImplementation(async (_thread, _count, _id, revert) => {
      await revert();
      useComposerDraftStore.getState().setPrompt(fixture.input.draftTarget, "Newer draft");
    });
    expect(await rewindToMessage(fixture.input)).toMatchObject({
      error: expect.stringContaining("The thread was rewound"),
    });
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.draftTarget)?.prompt,
    ).toBe("Newer draft");
  });

  it("restores the old question only after the rollback succeeds", async () => {
    using fixture = setup();
    expect(await rewindToMessage(fixture.input)).toEqual({
      error: null,
      prompt: "Keep this draft\n\nOriginal question",
    });
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(
      useComposerDraftStore.getState().getComposerDraft(fixture.input.draftTarget)?.prompt,
    ).toBe("Keep this draft\n\nOriginal question");
  });
});
