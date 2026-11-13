import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  RoomMessageId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { BotIcon, UsersIcon } from "lucide-react";
import type { RefObject } from "react";

import { prepareTurnAttachments } from "~/components/chat/chatViewSend";
import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { useQuietThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { roomAuthorLabel } from "./RoomMessageRow";
import { roomComposerStateAtom, setRoomComposerState } from "./roomComposerState";

const NO_THREAD = "";

/**
 * Where the composer's message goes in a thread with a room. Always shown there, so a message
 * meant for people never reaches the agent by mistake.
 */
export function useRoomComposerBanner(
  threadRef: ScopedThreadRef | null,
  threadKey: string | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const state = useAtomValue(roomComposerStateAtom(threadKey ?? NO_THREAD));
  if (room === null || threadKey === null) return [];
  const toPeople = state.to === "people";
  const people = room.participants.flatMap((participant) =>
    participant.name === null ? [] : [participant.name],
  );
  const switchTo = (to: "agent" | "people") =>
    setRoomComposerState(threadKey, (current) => ({
      to,
      replyTo: to === "agent" ? null : current.replyTo,
    }));
  return [
    {
      id: "thread-room-destination",
      variant: toPeople ? "info" : "default",
      icon: toPeople ? <UsersIcon /> : <BotIcon />,
      title: toPeople ? "To people only. The agent won't see this." : "To the agent",
      description:
        toPeople && state.replyTo !== null
          ? `Replying to ${roomAuthorLabel(state.replyTo.author, { kind: "owner" })}: ${state.replyTo.excerpt}`
          : people.length === 0
            ? "Nobody has joined yet."
            : `In the room: ${people.join(", ")}`,
      actions: (
        <Button size="xs" variant="ghost" onClick={() => switchTo(toPeople ? "agent" : "people")}>
          {toPeople ? "Send to the agent instead" : "Post to people instead"}
        </Button>
      ),
      ...(toPeople && state.replyTo !== null
        ? {
            dismissLabel: "Cancel reply",
            onDismiss: () =>
              setRoomComposerState(threadKey, (current) => ({ ...current, replyTo: null })),
          }
        : {}),
    },
  ];
}

/**
 * Posts the composer's text and files to people when that is where it goes. Resolves true when it
 * took the send, so the normal send to the agent does not run.
 */
export function useRoomComposerPost(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadKey: string | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: RefObject<string>;
  readonly onError: (threadId: ThreadId, message: string) => void;
}): () => Promise<boolean> {
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, {
    label: "post to people",
  });
  const threadRef =
    input.threadId === null
      ? null
      : { environmentId: input.environmentId, threadId: input.threadId };
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const state = useAtomValue(roomComposerStateAtom(input.threadKey ?? NO_THREAD));
  return async () => {
    if (
      room === null ||
      state.to !== "people" ||
      input.threadId === null ||
      input.threadKey === null
    ) {
      return false;
    }
    const threadId = input.threadId;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(input.composerDraftTarget);
    const text = input.promptRef.current.trim();
    const files = [...(draft?.images ?? []), ...(draft?.files ?? [])];
    if (
      (draft?.terminalContexts.length ?? 0) > 0 ||
      (draft?.reviewComments.length ?? 0) > 0 ||
      (draft?.threadContexts.length ?? 0) > 0 ||
      (draft?.environmentContexts.length ?? 0) > 0 ||
      (draft?.previewAnnotations.length ?? 0) > 0
    ) {
      input.onError(threadId, "Added context only goes to the agent. Remove it to post to people.");
      return true;
    }
    if (text === "" && files.length === 0) return true;
    let attachments;
    try {
      attachments = await prepareTurnAttachments({
        environmentId: input.environmentId,
        attachments: files,
        usesAttachmentUploads: true,
      });
    } catch (error) {
      input.onError(threadId, error instanceof Error ? error.message : "A file failed to upload.");
      return true;
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
          ...(state.replyTo === null ? {} : { replyTo: state.replyTo.itemId }),
        },
      },
    });
    if (result._tag === "Success") {
      store.clearComposerContent(input.composerDraftTarget);
      setRoomComposerState(input.threadKey, (current) => ({ ...current, replyTo: null }));
    } else {
      const error = squashAtomCommandFailure(result);
      input.onError(
        threadId,
        error instanceof Error ? error.message : "Could not post the message.",
      );
    }
    return true;
  };
}
