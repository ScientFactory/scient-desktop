import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  RoomMessageId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadRoom,
} from "@t3tools/contracts";
import type { RefObject } from "react";

import { prepareTurnAttachments } from "~/components/chat/chatViewSend";
import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { RoomAgentToggle } from "./RoomAgentToggle";
import { useRoomDirectStore } from "./roomDirectStore";

/** People are in the thread once someone has opened their invite. */
const hasPeople = (room: ThreadRoom | null): room is ThreadRoom =>
  room !== null && room.participants.some((participant) => participant.name !== null);

/** The owner's "straight to the agent" switch, shown while people are in the thread. */
export function OwnerRoomAgentToggle({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const key = threadRef === null ? "" : scopedThreadKey(threadRef);
  const on = useRoomDirectStore((state) => state.direct[key] === true);
  if (threadRef === null || !canOperate || !hasPeople(room)) return null;
  return (
    <RoomAgentToggle
      size="icon-sm"
      on={on}
      onChange={(next) => useRoomDirectStore.getState().setDirect(key, next)}
    />
  );
}

/**
 * In a thread with people in it, the composer's message is for them until someone sends it to
 * the agent, unless the owner turned on "straight to the agent". When `applies`, the send is
 * `post` and the normal send to the agent does not run.
 */
export function useRoomComposerPost(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: RefObject<string>;
  readonly onError: (threadId: ThreadId, message: string) => void;
}): { readonly applies: () => boolean; readonly post: () => Promise<void> } {
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, {
    label: "post message",
  });
  const threadRef =
    input.threadId === null
      ? null
      : { environmentId: input.environmentId, threadId: input.threadId };
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const key = threadRef === null ? "" : scopedThreadKey(threadRef);
  const direct = useRoomDirectStore((state) => state.direct[key] === true);
  // Decided synchronously, so a send to the agent goes out with no extra wait.
  const applies = () => input.threadId !== null && !direct && hasPeople(room);
  const post = async () => {
    if (input.threadId === null) return;
    const threadId = input.threadId;
    const target = input.composerDraftTarget;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(target);
    const prompt = input.promptRef.current;
    const text = prompt.trim();
    const images = [...(draft?.images ?? [])];
    const files = [...(draft?.files ?? [])];
    if (
      (draft?.terminalContexts.length ?? 0) > 0 ||
      (draft?.reviewComments.length ?? 0) > 0 ||
      (draft?.threadContexts.length ?? 0) > 0 ||
      (draft?.environmentContexts.length ?? 0) > 0 ||
      (draft?.previewAnnotations.length ?? 0) > 0
    ) {
      input.onError(
        threadId,
        "Added context only goes to the agent. Turn on Send straight to the agent, or remove it.",
      );
      return;
    }
    if (text === "" && images.length === 0 && files.length === 0) return;
    // The composer is free for the next message at once; what was posted returns only on failure.
    store.clearComposerContent(target);
    const restore = (message: string) => {
      const current = useComposerDraftStore.getState().getComposerDraft(target);
      const untouched =
        (current?.prompt.trim() ?? "") === "" &&
        (current?.images.length ?? 0) === 0 &&
        (current?.files.length ?? 0) === 0;
      if (untouched) {
        store.setPrompt(target, prompt);
        store.addImages(target, images);
        store.addFiles(target, files);
      }
      input.onError(threadId, message);
    };
    let attachments;
    try {
      attachments = await prepareTurnAttachments({
        environmentId: input.environmentId,
        attachments: [...images, ...files],
        usesAttachmentUploads: true,
      });
    } catch (error) {
      restore(error instanceof Error ? error.message : "A file failed to upload.");
      return;
    }
    const result = await roomAction({
      environmentId: input.environmentId,
      input: {
        threadId,
        action: {
          type: "post",
          roomMessageId: RoomMessageId.make(randomUUID()),
          text,
          attachments,
        },
      },
    });
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      restore(error instanceof Error ? error.message : "Could not post the message.");
    }
  };
  return { applies, post };
}
