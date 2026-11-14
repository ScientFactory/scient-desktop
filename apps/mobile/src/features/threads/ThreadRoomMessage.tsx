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
import { roomAuthorLabel, type RoomMessageItem } from "./thread-room.logic";
import { roomCommandSucceeded } from "./room-command-result";

export function ThreadRoomMessage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: RoomMessageItem;
  readonly bubbleMaxWidth: number | `${number}%`;
  readonly renderAttachments: (attachments: ReadonlyArray<ChatAttachment>) => ReactNode;
}) {
  const { threadRef, item } = props;
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const send = useAtomCommand(threadEnvironment.sendRoomMessage, { reportFailure: false });
  const action = useAtomCommand(threadEnvironment.roomAction, { reportFailure: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (kind: "send" | "delete") => {
    if (inFlight.current || !canOperate) return;
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
  // Like a queued message: dashed and unfilled until someone sends it to the agent.
  return (
    <View className="items-end gap-1 pb-5">
      <Text className="text-xs text-foreground-muted">{roomAuthorLabel(item.author)}</Text>
      <View
        className="min-w-0 gap-2 rounded-[20px] border border-dashed border-border px-3.5 py-2.5"
        style={{ maxWidth: props.bubbleMaxWidth }}
      >
        {item.text ? (
          <Text selectable className="text-base text-foreground-muted">
            {item.text}
          </Text>
        ) : null}
        {props.renderAttachments(item.attachments ?? [])}
      </View>
      {canOperate ? (
        <View className="flex-row gap-1">
          <Button
            size="compact"
            label="Send to agent"
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
                message: "The message text and files will be removed for everyone.",
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
