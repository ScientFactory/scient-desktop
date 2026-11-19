import { RoomMessageId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg, useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import { uploadComposerAttachmentShared } from "../../state/composer-attachment-uploads";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftAttachmentUpload,
} from "../../state/use-composer-drafts";
import { roomCommandSucceeded } from "./room-command-result";
import { roomPostError } from "./thread-room.logic";
import { readRoomDirect, setRoomDirect, useRoomDirect, useThreadRoom } from "./thread-room-state";

/** In a shared thread with people in it: send straight to the agent instead of to everyone. */
export function RoomAgentSwitch(props: { readonly threadKey: string; readonly disabled: boolean }) {
  const direct = useRoomDirect(props.threadKey);
  const gt = useGT();
  return (
    <View className="flex-row px-2 pb-2">
      <Button
        label={gt("Straight to agent")}
        size="compact"
        tone={direct ? "primary" : "secondary"}
        disabled={props.disabled}
        onPress={() => setRoomDirect(props.threadKey, !direct)}
        accessibilityLabel={
          direct
            ? gt("Straight to agent, on")
            : gt("Straight to agent, off. Messages go to everyone first.")
        }
      />
    </View>
  );
}

export function useRoomPost(
  threadRef: ScopedThreadRef | null,
  threadKey: string,
  draftKey: string,
) {
  const room = useThreadRoom(threadRef);
  const direct = useRoomDirect(threadKey);
  const post = useAtomCommand(threadEnvironment.roomAction, { reportFailure: false });
  const [posting, setPosting] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ signature: string; id: RoomMessageId } | null>(null);
  const nowMs = useNowMinuteMs();
  // With people in the thread, a message is for them until someone sends it to the agent.
  // Someone whose access ended is not in it.
  const hasPeople =
    room?.participants.some(
      (participant) => participant.name !== null && Date.parse(participant.expiresAt) > nowMs,
    ) ?? false;
  const toPeople = hasPeople && !direct;
  const send = async (stillSendable: () => boolean) => {
    if (!toPeople || threadRef === null || inFlight.current) return;
    if (room === null) return;
    const draft = getComposerDraftSnapshot(draftKey);
    const error = roomPostError(draft);
    if (error) {
      Dialog.alert(m(msg("Could not post to people")), error);
      return;
    }
    const signature = JSON.stringify({
      threadKey,
      roomId: room.id,
      text: draft.text,
      attachments: draft.attachments.map((attachment) => attachment.id),
    });
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: RoomMessageId.make(uuidv4()) };
    const roomMessageId = attempt.current.id;
    inFlight.current = true;
    setPosting(true);
    const attemptPost = async () => {
      const prepared = await Effect.runPromise(
        prepareTurnAttachments({
          environmentId: threadRef.environmentId,
          attachments: draft.attachments,
          supportsImageUploads: true,
          // Joins the composer's own upload of the same attachment, as a turn's send does.
          uploadAttachment: (attachment) =>
            uploadComposerAttachmentShared(threadRef.environmentId, attachment),
          persistUploadedReferences: (attachments) =>
            Effect.sync(() => {
              if (!stillSendable()) return "abandon" as const;
              for (const attachment of attachments)
                setComposerDraftAttachmentUpload(draftKey, attachment);
              return "persisted" as const;
            }),
        }),
      );
      if (prepared.status !== "ready") return;
      for (const attachment of prepared.draftAttachments)
        setComposerDraftAttachmentUpload(draftKey, attachment);
      if (!stillSendable() || readRoomDirect(threadKey) !== direct) return;
      const attachments = prepared.attachments.map((attachment) => {
        if (attachment.id === undefined)
          throw new Error("Upload the files before posting to people.");
        return { ...attachment, id: attachment.id };
      });
      const result = await post({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          action: {
            type: "post",
            roomMessageId,
            text: draft.text.trim(),
            attachments,
          },
        },
      });
      if (roomCommandSucceeded(result)) {
        if (stillSendable()) clearComposerDraftContent(draftKey);
        attempt.current = null;
      }
    };
    await attemptPost().catch((error: unknown) => {
      Dialog.alert(
        m(msg("Could not post to people")),
        error instanceof Error ? error.message : m(msg("Try again.")),
      );
    });
    inFlight.current = false;
    setPosting(false);
  };
  return { hasPeople, direct, toPeople, posting, send };
}
