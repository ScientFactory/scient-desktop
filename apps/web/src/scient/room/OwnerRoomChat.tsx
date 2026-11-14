import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ChatAttachment,
  type EnvironmentId,
  RoomMessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, use } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { prepareTurnAttachments } from "~/components/chat/chatViewSend";
import { composerFileAttachmentMimeType } from "~/components/chat/composerAttachmentFiles";
import { GuestMessageAttachments } from "~/components/chat/GuestMessageAttachments";
import type { ComposerFileAttachment } from "~/composerDraftStore";
import { startAttachmentUpload } from "~/lib/attachmentUploadQueue";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { isImageAttachment } from "~/types";
import { RoomChat, type RoomChatActions, type RoomMessageItem, roomChatMessages } from "./RoomChat";

const OWNER = { kind: "owner" } as const;

const ThreadContext = createContext<ScopedThreadRef | null>(null);

/** A chat message's files, served by the owner's environment and opened in the side panel. */
function OwnerRoomAttachments({ item }: { readonly item: RoomMessageItem }) {
  const threadRef = use(ThreadContext);
  const images = (item.attachments ?? []).filter(isImageAttachment);
  const urls = useAssetUrls(
    threadRef?.environmentId ?? ("" as EnvironmentId),
    images.map((image) => ({ _tag: "attachment" as const, attachmentId: image.id })),
  );
  if (threadRef === null) return null;
  const open = (attachment: ChatAttachment) => {
    if (attachment.type !== "file" && attachment.type !== "image") return;
    useRightPanelStore.getState().openAttachment(threadRef, {
      type: "file",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  };
  return (
    // The shared attachment layout aligns to the end; chat lines read from the start.
    <div className="[&>div]:items-start">
      <GuestMessageAttachments
        attachments={item.attachments ?? []}
        imageUrl={(attachment) =>
          urls[images.findIndex((image) => image.id === attachment.id)] ?? undefined
        }
        onOpenImage={open}
        onOpenFile={open}
      />
    </div>
  );
}

/** Uploads the files the owner adds to a chat message, as the composer uploads its own. */
async function uploadChatFiles(environmentId: EnvironmentId, files: ReadonlyArray<File>) {
  const attachments: ReadonlyArray<ComposerFileAttachment> = files.map((file) => ({
    type: "file",
    id: randomUUID(),
    name: file.name || "file",
    mimeType: composerFileAttachmentMimeType(file),
    sizeBytes: file.size,
    file,
  }));
  for (const attachment of attachments) startAttachmentUpload({ environmentId, image: attachment });
  return prepareTurnAttachments({ environmentId, attachments, usesAttachmentUploads: true });
}

/** The people chat of a shared thread, in the owner's side panel. */
export function OwnerRoomChat({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const room = projection?.thread.room ?? null;
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const sendRoomMessage = useOrchestrationCommand(threadEnvironment.sendRoomMessage, {
    label: "send chat message to agent",
  });
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, {
    label: "chat",
  });
  const target = { environmentId: threadRef.environmentId };
  const actions: RoomChatActions = {
    viewer: OWNER,
    canPost: canOperate && room !== null,
    canSendToAgent: canOperate,
    canDelete: canOperate,
    Attachments: OwnerRoomAttachments,
    onPost: async (text, files) => {
      let attachments;
      try {
        attachments = await uploadChatFiles(threadRef.environmentId, files);
      } catch (error) {
        return error instanceof Error ? error.message : "A file failed to upload.";
      }
      const result = await roomAction({
        ...target,
        input: {
          threadId: threadRef.threadId,
          action: {
            type: "post",
            roomMessageId: RoomMessageId.make(randomUUID()),
            text,
            attachments,
          },
        },
      });
      if (result._tag === "Success") return null;
      const error = squashAtomCommandFailure(result);
      return error instanceof Error ? error.message : "Could not send the message.";
    },
    onSend: async (item) => {
      await sendRoomMessage({
        ...target,
        input: { threadId: threadRef.threadId, itemId: item.id },
      });
    },
    onDelete: async (item) => {
      await roomAction({
        ...target,
        input: { threadId: threadRef.threadId, action: { type: "delete", itemId: item.id } },
      });
    },
  };
  return (
    <ThreadContext value={threadRef}>
      <RoomChat messages={roomChatMessages(projection?.turnItems ?? [])} actions={actions} />
    </ThreadContext>
  );
}
