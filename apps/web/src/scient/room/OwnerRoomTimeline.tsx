import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, type ReactNode, use } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "~/components/chat/ExpandedImagePreview";
import { GuestMessageAttachments } from "~/components/chat/GuestMessageAttachments";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { type ChatFileAttachment, isImageAttachment } from "~/types";
import {
  type RoomMessageItem,
  RoomTimelineContext,
  type RoomTimelineActions,
} from "./RoomMessageRow";
import { replyInRoom } from "./roomComposerState";

const OWNER = { kind: "owner" } as const;

interface OwnerFiles {
  readonly environmentId: EnvironmentId;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}
const OwnerFilesContext = createContext<OwnerFiles | null>(null);

/** A room message's files, served by the owner's environment like any thread attachment. */
function OwnerRoomAttachments({ item }: { readonly item: RoomMessageItem }) {
  const files = use(OwnerFilesContext);
  const images = (item.attachments ?? []).filter(isImageAttachment);
  const urls = useAssetUrls(
    files?.environmentId ?? ("" as EnvironmentId),
    images.map((image) => ({ _tag: "attachment" as const, attachmentId: image.id })),
  );
  if (files === null) return null;
  const urlOf = (id: string) => urls[images.findIndex((image) => image.id === id)] ?? undefined;
  return (
    <GuestMessageAttachments
      attachments={item.attachments ?? []}
      imageUrl={(attachment) => urlOf(attachment.id)}
      onOpenImage={(attachment) => {
        const preview = buildExpandedImagePreview(
          images.map((image) => ({ ...image, previewUrl: urlOf(image.id) ?? "" })),
          attachment.id,
        );
        if (preview) files.onImageExpand(preview);
      }}
      onOpenFile={files.onFileOpen}
    />
  );
}

/** The owner's room actions for the timeline rows of one thread. */
export function OwnerRoomTimeline(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
  readonly onReply: () => void;
  readonly children: ReactNode;
}) {
  const { threadRef } = props;
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const sendRoomMessage = useOrchestrationCommand(threadEnvironment.sendRoomMessage, {
    label: "send room message to agent",
  });
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, {
    label: "room action",
  });
  if (threadRef === null) return props.children;
  const target = { environmentId: threadRef.environmentId };
  const actions: RoomTimelineActions = {
    viewer: OWNER,
    canPost: canOperate && room !== null,
    canSendToAgent: canOperate,
    canDelete: canOperate,
    Attachments: OwnerRoomAttachments,
    onReply: (reply) => {
      replyInRoom(scopedThreadKey(threadRef), reply);
      props.onReply();
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
    <OwnerFilesContext
      value={{
        environmentId: threadRef.environmentId,
        onImageExpand: props.onImageExpand,
        onFileOpen: props.onFileOpen,
      }}
    >
      <RoomTimelineContext value={actions}>{props.children}</RoomTimelineContext>
    </OwnerFilesContext>
  );
}
