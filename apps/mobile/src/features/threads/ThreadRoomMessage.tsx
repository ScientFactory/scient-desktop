import type { ChatAttachment, ScopedThreadRef } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  roomAuthorLabel,
  roomDeliveryLabel,
  roomReplyTarget,
  type RoomMessageItem,
} from "./thread-room.logic";
import { roomCommandSucceeded } from "./room-command-result";
import { replyInRoom, useThreadRoom } from "./thread-room-state";

export function ThreadRoomMessage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: RoomMessageItem;
  readonly bubbleMaxWidth: number | `${number}%`;
  readonly renderAttachments: (attachments: ReadonlyArray<ChatAttachment>) => ReactNode;
}) {
  const { threadRef, item } = props;
  const room = useThreadRoom(threadRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const send = useAtomCommand(threadEnvironment.sendRoomMessage, { reportFailure: false });
  const action = useAtomCommand(threadEnvironment.roomAction, { reportFailure: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const deleted = item.deletedAt !== undefined;
  const delivery = roomDeliveryLabel(item);
  const run = async (kind: "send" | "delete") => {
    if (inFlight.current || !canOperate || deleted) return;
    inFlight.current = true;
    setBusy(true);
    const perform = async () => {
      const result =
        kind === "send"
          ? await send({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, itemId: item.id, creationSource: "mobile" },
            })
          : await action({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, action: { type: "delete", itemId: item.id } },
            });
      roomCommandSucceeded(result);
    };
    await perform().catch((error: unknown) => {
      Dialog.alert("Room action failed", error instanceof Error ? error.message : "Try again.");
    });
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <View className="items-start gap-1 pb-5">
      <Text className="text-xs text-foreground-muted">
        {roomAuthorLabel(item.author)} · To people
      </Text>
      <View
        className="min-w-0 gap-2 rounded-[20px] border border-border px-3.5 py-2.5"
        style={{ maxWidth: props.bubbleMaxWidth }}
      >
        {deleted ? (
          <Text className="text-sm italic text-foreground-muted">Message deleted</Text>
        ) : (
          <>
            {item.replyTo ? (
              <Text className="border-l-2 border-border pl-2 text-xs text-foreground-muted">
                {roomAuthorLabel(item.replyTo.author)}: {item.replyTo.excerpt}
              </Text>
            ) : null}
            {item.text ? (
              <Text selectable className="text-base text-foreground">
                {item.text}
              </Text>
            ) : null}
            {props.renderAttachments(item.attachments ?? [])}
          </>
        )}
      </View>
      {!deleted && item.suggested ? (
        <Text className="text-xs text-foreground-muted">Suggested for the agent</Text>
      ) : null}
      {delivery ? <Text className="text-xs text-foreground-muted">{delivery}</Text> : null}
      {!deleted && canOperate ? (
        <View className="flex-row flex-wrap gap-1">
          {room !== null ? (
            <Button
              size="compact"
              label="Reply"
              tone="text"
              disabled={busy}
              onPress={() => replyInRoom(threadRef, roomReplyTarget(item))}
            />
          ) : null}
          <Button
            size="compact"
            label={
              item.deliveries?.some((entry) => entry.status === "sent")
                ? "Send again"
                : "Send to agent"
            }
            tone="text"
            disabled={busy}
            onPress={() => void run("send")}
          />
          <Button
            size="compact"
            label="Delete"
            tone="text"
            disabled={busy}
            onPress={() =>
              Dialog.confirm({
                title: "Delete this message?",
                message: "The message text and files will be removed from the room.",
                confirmText: "Delete",
                destructive: true,
                onConfirm: () => void run("delete"),
              })
            }
          />
        </View>
      ) : null}
    </View>
  );
}
