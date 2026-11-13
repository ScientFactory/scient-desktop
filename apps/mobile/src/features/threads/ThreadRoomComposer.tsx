import { RoomMessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftAttachmentUpload,
} from "../../state/use-composer-drafts";
import { roomCommandSucceeded } from "./room-command-result";
import { roomAuthorLabel, roomPostError } from "./thread-room.logic";
import {
  clearRoomReply,
  setRoomDestination,
  useRoomComposerState,
  useThreadRoom,
  readRoomComposerState,
} from "./thread-room-state";

export function RoomDestination(props: { readonly threadKey: string; readonly disabled: boolean }) {
  const state = useRoomComposerState(props.threadKey);
  return (
    <View className="gap-1 px-2 pb-2">
      <View className="flex-row gap-2">
        <Button
          label="Agent"
          size="compact"
          tone={state.to === "agent" ? "primary" : "secondary"}
          disabled={props.disabled}
          onPress={() => setRoomDestination(props.threadKey, "agent")}
          accessibilityLabel={
            state.to === "agent" ? "Agent, selected destination" : "Send to agent"
          }
        />
        <Button
          label="People"
          size="compact"
          tone={state.to === "people" ? "primary" : "secondary"}
          disabled={props.disabled}
          onPress={() => setRoomDestination(props.threadKey, "people")}
          accessibilityLabel={
            state.to === "people" ? "People, selected destination" : "Post to people"
          }
        />
      </View>
      <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
        {state.to === "people" ? "To people only. The agent won't see this." : "To the agent"}
      </Text>
      {state.to === "people" && state.replyTo ? (
        <View className="flex-row items-center gap-1 rounded-xl border border-border p-2">
          <Text numberOfLines={2} className="min-w-0 flex-1 text-xs text-foreground-muted">
            Replying to {roomAuthorLabel(state.replyTo.author)}: {state.replyTo.excerpt}
          </Text>
          <Button
            label="Cancel reply"
            size="compact"
            tone="text"
            disabled={props.disabled}
            onPress={() => clearRoomReply(props.threadKey)}
          />
        </View>
      ) : null}
    </View>
  );
}

export function useRoomPost(
  threadRef: ScopedThreadRef | null,
  threadKey: string,
  draftKey: string,
) {
  const room = useThreadRoom(threadRef);
  const state = useRoomComposerState(threadKey);
  const post = useAtomCommand(threadEnvironment.roomAction, { reportFailure: false });
  const [posting, setPosting] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ signature: string; id: RoomMessageId } | null>(null);
  const toPeople = state.to === "people";
  const send = async (stillSendable: () => boolean) => {
    if (!toPeople || threadRef === null || inFlight.current) return;
    if (room === null) {
      Dialog.alert("Room closed", "Switch to Agent to send this draft to the agent.");
      return;
    }
    const draft = getComposerDraftSnapshot(draftKey);
    const error = roomPostError(draft);
    if (error) {
      Dialog.alert("Could not post to people", error);
      return;
    }
    const signature = JSON.stringify({
      threadKey,
      roomId: room.id,
      text: draft.text,
      attachments: draft.attachments.map((attachment) => attachment.id),
      replyTo: state.replyTo?.itemId,
    });
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: RoomMessageId.make(uuidv4()) };
    const roomMessageId = attempt.current.id;
    inFlight.current = true;
    setPosting(true);
    try {
      const prepared = await prepareTurnAttachments({
        environmentId: threadRef.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: true,
        persistUploadedReferences: async (attachments) => {
          if (!stillSendable()) return "abandon";
          for (const attachment of attachments)
            setComposerDraftAttachmentUpload(draftKey, attachment);
          return "persisted";
        },
      });
      if (prepared.status !== "ready") return;
      for (const attachment of prepared.draftAttachments)
        setComposerDraftAttachmentUpload(draftKey, attachment);
      if (!stillSendable() || readRoomComposerState(threadKey) !== state) return;
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
            ...(state.replyTo ? { replyTo: state.replyTo.itemId } : {}),
          },
        },
      });
      if (roomCommandSucceeded(result)) {
        if (stillSendable()) clearComposerDraftContent(draftKey);
        if (readRoomComposerState(threadKey) === state) clearRoomReply(threadKey);
        attempt.current = null;
      }
    } catch (error) {
      Dialog.alert(
        "Could not post to people",
        error instanceof Error ? error.message : "Try again.",
      );
    } finally {
      inFlight.current = false;
      setPosting(false);
    }
  };
  return { hasRoom: room !== null, toPeople, posting, send };
}
