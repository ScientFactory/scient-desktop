import { useAtomValue } from "@effect/atom-react";
import {
  ROOM_PARTICIPANT_LIMIT,
  type RoomAccessDuration,
  type RoomParticipant,
  type RoomRole,
  type ScopedThreadRef,
  type ThreadRoomOwnerAction,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { msg, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Share, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { roomCommandSucceeded } from "./room-command-result";
import { useThreadRoom } from "./thread-room-state";

// The UI's words for each room role.
const ROLE_TITLES: Record<RoomRole, string> = {
  watch: msg("Can view"),
  discuss: msg("Can chat"),
  agent: msg("Can use agent"),
};
const ROLE_IDS = ["discuss", "agent"] as const;
const DURATION_TITLES: ReadonlyArray<{ id: RoomAccessDuration; title: string }> = [
  { id: "day", title: msg("1 day") },
  { id: "week", title: msg("1 week") },
  { id: "month", title: msg("1 month") },
];

export function ThreadRoomBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  return props.threadRef === null ? null : (
    <RoomBar threadRef={props.threadRef} canOperateThread={props.canOperateThread} />
  );
}

function RoomBar({
  threadRef,
  canOperateThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly canOperateThread: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const roles = ROLE_IDS.map((id) => ({ id, title: messages(ROLE_TITLES[id]) }));
  const durations = DURATION_TITLES.map((duration) => ({
    id: duration.id,
    title: messages(duration.title),
  }));
  const room = useThreadRoom(threadRef);
  const canInvite = useAtomValue(
    serverEnvironment.inviteToThreadRoom.permissionAtom(threadRef.environmentId),
  );
  const canGetLink = useAtomValue(
    serverEnvironment.threadRoomInviteLink.permissionAtom(threadRef.environmentId),
  );
  const presence = useEnvironmentQuery(
    room === null
      ? null
      : serverEnvironment.threadRoomPresence({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const invite = useAtomCommand(serverEnvironment.inviteToThreadRoom, { reportFailure: false });
  const inviteLink = useAtomCommand(serverEnvironment.threadRoomInviteLink, {
    reportFailure: false,
  });
  const action = useAtomCommand(threadEnvironment.roomAction, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const disabled = busy || !canOperateThread;
  const run = async (operation: () => Promise<void>) => {
    if (inFlight.current || !canOperateThread) return;
    inFlight.current = true;
    setBusy(true);
    await operation().catch((error: unknown) => {
      Dialog.alert(
        m(msg("Room action failed")),
        error instanceof Error ? error.message : m(msg("Try again.")),
      );
    });
    inFlight.current = false;
    setBusy(false);
  };
  const mutate = (roomAction: ThreadRoomOwnerAction) =>
    run(async () => {
      roomCommandSucceeded(
        await action({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, action: roomAction },
        }),
      );
    });
  const shareInvite = (role: RoomRole, duration: RoomAccessDuration) =>
    run(async () => {
      const result = await invite({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, role, duration },
      });
      if (roomCommandSucceeded(result)) {
        setExpanded(true);
        await Share.share({ message: result.value.url });
      }
    });
  const pendingLink = (participant: RoomParticipant, copy: boolean) =>
    run(async () => {
      const result = await inviteLink({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, participantId: participant.id },
      });
      if (!roomCommandSucceeded(result)) return;
      if (copy) await Clipboard.setStringAsync(result.value.url);
      else await Share.share({ message: result.value.url });
    });
  const remove = (participant: RoomParticipant) =>
    Dialog.confirm({
      title: m(msg("Remove this person?")),
      message: participant.name
        ? m(msg("{name} will lose access to the room.", { name: participant.name }))
        : m(msg("This invited person will lose access to the room.")),
      confirmText: m(msg("Remove", { $context: "verb, removes the person from the room" })),
      destructive: true,
      onConfirm: () => void mutate({ type: "remove", participantId: participant.id }),
    });
  if (!room && !canInvite) return null;
  return (
    <View className="gap-2 px-4 pb-2">
      <View className="flex-row flex-wrap items-center gap-1">
        {room ? (
          <Button
            size="compact"
            label={gt(
              "{count, plural, one {Room · {count} people} other {Room · {count} people}}",
              { count: room.participants.length },
            )}
            tone="text"
            onPress={() => setExpanded(!expanded)}
            accessibilityHint={expanded ? gt("Hide room members") : gt("Show room members")}
          />
        ) : null}
        <Menu
          actions={roles.map((role) => ({
            id: role.id,
            title: role.title,
            subactions: durations.map((duration) => ({
              id: `${role.id}:${duration.id}`,
              title: duration.title,
            })),
            attributes: {
              disabled:
                disabled ||
                !canInvite ||
                (room?.participants.length ?? 0) >= ROOM_PARTICIPANT_LIMIT,
            },
          }))}
          onPressAction={({ nativeEvent }) => {
            const choice = roles
              .flatMap((role) =>
                durations.map((duration) => ({
                  id: `${role.id}:${duration.id}`,
                  role: role.id,
                  duration: duration.id,
                })),
              )
              .find((entry) => entry.id === nativeEvent.event);
            if (choice && !disabled && canInvite) void shareInvite(choice.role, choice.duration);
          }}
        >
          <Button
            size="compact"
            label={gt("Invite", { $context: "verb, invites someone to the room" })}
            tone="text"
            disabled={
              disabled || !canInvite || (room?.participants.length ?? 0) >= ROOM_PARTICIPANT_LIMIT
            }
            onPress={() => {}}
            accessibilityHint={gt("Choose a role and how long access lasts")}
          />
        </Menu>
        {room ? (
          <Button
            size="compact"
            label={gt("Stop sharing")}
            tone="text"
            disabled={disabled}
            onPress={() =>
              Dialog.confirm({
                title: m(msg("Stop sharing this room?")),
                message: m(msg("Everyone loses access. All invite links stop working.")),
                confirmText: m(msg("Stop sharing")),
                destructive: true,
                onConfirm: () => void mutate({ type: "close" }),
              })
            }
          />
        ) : null}
      </View>
      {room && !expanded ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {room.participants
            .map(
              (participant) =>
                participant.name ??
                gt("Invited", { $context: "a person invited who has not joined" }),
            )
            .join(", ") || gt("Nobody has joined yet.")}
        </Text>
      ) : null}
      {room && expanded ? (
        <View className="gap-2">
          {presence.error ? (
            <Text className="text-xs text-foreground-muted">{gt("Presence unavailable")}</Text>
          ) : null}
          {room.participants.length === 0 ? (
            <Text className="text-xs text-foreground-muted">
              {gt("Nobody has been invited yet.")}
            </Text>
          ) : null}
          {room.participants.map((participant) => {
            const pending = participant.joinedAt === null;
            const online = !presence.error && presence.data?.online.includes(participant.id);
            return (
              <View key={participant.id} className="gap-1 rounded-xl border border-border p-2">
                <Text className="text-sm text-foreground">
                  {participant.name ??
                    gt("Invited", { $context: "a person invited who has not joined" })}{" "}
                  · {messages(ROLE_TITLES[participant.role])} ·{" "}
                  {online
                    ? gt("Online")
                    : presence.data && !presence.error
                      ? gt("Offline")
                      : gt("Presence unknown")}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {gt("Access until {date}", {
                    date: new Date(participant.expiresAt).toLocaleString(),
                  })}
                </Text>
                <View className="flex-row flex-wrap gap-1">
                  <Menu
                    actions={roles.map((role) => ({
                      ...role,
                      state: role.id === participant.role ? ("on" as const) : ("off" as const),
                      attributes: { disabled },
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      const role = roles.find((entry) => entry.id === nativeEvent.event);
                      if (role && !disabled)
                        void mutate({
                          type: "set-role",
                          participantId: participant.id,
                          role: role.id,
                        });
                    }}
                  >
                    <Button
                      size="compact"
                      label={gt("Change role")}
                      tone="text"
                      disabled={disabled}
                      onPress={() => {}}
                    />
                  </Menu>
                  {pending ? (
                    <>
                      <Button
                        size="compact"
                        label={gt("Copy invite")}
                        tone="text"
                        disabled={disabled || !canGetLink}
                        onPress={() => void pendingLink(participant, true)}
                      />
                      <Button
                        size="compact"
                        label={gt("Share invite")}
                        tone="text"
                        disabled={disabled || !canGetLink}
                        onPress={() => void pendingLink(participant, false)}
                      />
                    </>
                  ) : null}
                  {pending ? null : (
                    // Access again from now, keeping their permission.
                    <Menu
                      title={gt("Renew from now for")}
                      actions={durations.map((duration) => ({
                        ...duration,
                        attributes: { disabled },
                      }))}
                      onPressAction={({ nativeEvent }) => {
                        const duration = durations.find((entry) => entry.id === nativeEvent.event);
                        if (duration && !disabled)
                          void mutate({
                            type: "renew",
                            participantId: participant.id,
                            duration: duration.id,
                          });
                      }}
                    >
                      <Button
                        size="compact"
                        label={gt("Renew", { $context: "verb, renews access" })}
                        tone="text"
                        disabled={disabled}
                        onPress={() => {}}
                      />
                    </Menu>
                  )}
                  <Button
                    size="compact"
                    label={gt("Remove", { $context: "verb, removes the person from the room" })}
                    tone="text"
                    disabled={disabled}
                    onPress={() => remove(participant)}
                  />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
