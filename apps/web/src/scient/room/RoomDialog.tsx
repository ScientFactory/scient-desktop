import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ROOM_ROLE_LABEL,
  roomWaitingCount,
  type RoomAccessDuration,
  type RoomParticipant,
  type RoomRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, MessagesSquareIcon, ShareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { guestShareDialogThreadAtom } from "~/components/chat/guestShareDialogState";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentSubscription } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { scientRoomChatSurface } from "~/scient/rightPanel/surfaces";

const DURATION_LABEL: Record<RoomAccessDuration, string> = {
  day: "1 day",
  week: "7 days",
  month: "30 days",
};

const expiryLabel = (expiresAt: string) =>
  new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function useRoomPresence(threadRef: ScopedThreadRef): ReadonlySet<string> {
  const presence = useEnvironmentSubscription(
    serverEnvironment.threadRoomPresence({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  return new Set(presence.data?.online ?? []);
}

/** Renders the room dialog for the thread the share commands opened it for. */
export function RoomDialogHost() {
  const threadRef = useAtomValue(guestShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <RoomDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(guestShareDialogThreadAtom, null)}
    />
  );
}

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

const ROLES = ["watch", "discuss", "agent"] as const;
const DURATIONS = ["day", "week", "month"] as const;

function RoomDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const online = useRoomPresence(threadRef);
  const canInvite = useAtomValue(
    serverEnvironment.inviteToThreadRoom.permissionAtom(threadRef.environmentId),
  );
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const invite = useAtomCommand(serverEnvironment.inviteToThreadRoom, { reportFailure: false });
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, { label: "room" });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "invite link" });
  const [role, setRole] = useState<RoomRole>("discuss");
  const [duration, setDuration] = useState<RoomAccessDuration>("week");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One step: the invite is made and its link copied, ready to paste to the person.
  const createInvite = async () => {
    setCreating(true);
    setError(null);
    const result = await invite({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, role, duration },
    });
    setCreating(false);
    if (result._tag === "Success") copyToClipboard(result.value.url);
    else if (!isAtomCommandInterrupted(result))
      setError(failureMessage(result, "Could not create an invite."));
  };

  const act = (action: Parameters<typeof roomAction>[0]["input"]["action"]) =>
    roomAction({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, action },
    });

  const joined = (room?.participants ?? []).filter((participant) => participant.name !== null);
  const unopened = (room?.participants ?? []).filter((participant) => participant.name === null);
  return (
    <Dialog open onOpenChange={(open) => (!open && !creating ? onClose() : null)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>People you invite see this thread live.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2" aria-label="New invite">
              <div className="flex items-center gap-2">
                <RolePicker label="Permission" size="sm" value={role} onChange={setRole} />
                <Select
                  value={duration}
                  onValueChange={(next) => setDuration(next as RoomAccessDuration)}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-24 min-w-0 shrink-0"
                    aria-label="Access for"
                  >
                    <SelectValue>{DURATION_LABEL[duration]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {DURATIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {DURATION_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto shrink-0"
                  disabled={!canInvite || creating}
                  onClick={() => void createInvite()}
                >
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                  {/* Both words hold their space, so the button keeps its width when it changes. */}
                  <span className="grid">
                    <span className={cn("col-start-1 row-start-1", isCopied && "invisible")}>
                      Copy link
                    </span>
                    <span className={cn("col-start-1 row-start-1", !isCopied && "invisible")}>
                      Copied
                    </span>
                  </span>
                </Button>
              </div>
              {error !== null ? (
                <p role="alert" className="text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </section>
            {joined.length > 0 || unopened.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label="People in this room">
                {joined.map((participant) => (
                  <ParticipantRow
                    key={participant.id}
                    participant={participant}
                    online={online.has(participant.id)}
                    canManage={canOperate}
                    onRole={(next) =>
                      void act({ type: "set-role", participantId: participant.id, role: next })
                    }
                    onRemove={() => void act({ type: "remove", participantId: participant.id })}
                  />
                ))}
                {unopened.length > 0 ? (
                  // Links nobody has opened yet are one line, not a row each: they are not people.
                  <li className="flex h-7 items-center gap-2 ps-4 text-muted-foreground text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {unopened.length === 1
                        ? "1 link not opened yet"
                        : `${unopened.length} links not opened yet`}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!canOperate}
                      onClick={() => {
                        for (const participant of unopened)
                          void act({ type: "remove", participantId: participant.id });
                      }}
                    >
                      {unopened.length === 1 ? "Cancel it" : "Cancel them"}
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** What someone may do: Can view, Can chat or Can use agent. */
function RolePicker(props: {
  readonly label: string;
  readonly size: "sm" | "xs";
  readonly value: RoomRole;
  readonly disabled?: boolean;
  readonly onChange: (role: RoomRole) => void;
}) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => props.onChange(next as RoomRole)}
    >
      <SelectTrigger
        size={props.size}
        className={cn("min-w-0 shrink-0", props.size === "sm" ? "w-36" : "w-32")}
        aria-label={props.label}
      >
        <SelectValue>{ROOM_ROLE_LABEL[props.value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {ROLES.map((value) => (
          <SelectItem key={value} value={value}>
            {ROOM_ROLE_LABEL[value]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ParticipantRow(props: {
  readonly participant: RoomParticipant;
  readonly online: boolean;
  readonly canManage: boolean;
  readonly onRole: (role: RoomRole) => void;
  readonly onRemove: () => void;
}) {
  const { participant } = props;
  const name = participant.name ?? "Invited";
  return (
    <li className="flex h-7 items-center gap-2">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", props.online ? "bg-success" : "bg-border")}
      />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
          {name}
          <span className="sr-only">{props.online ? ", here now" : ""}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Access until {expiryLabel(participant.expiresAt)}</TooltipPopup>
      </Tooltip>
      <RolePicker
        label={`Permission of ${name}`}
        size="xs"
        value={participant.role}
        disabled={!props.canManage}
        onChange={props.onRole}
      />
      <Button
        size="icon-xs"
        variant="ghost-muted"
        disabled={!props.canManage}
        aria-label={`Remove ${name}`}
        onClick={props.onRemove}
      >
        <XIcon />
      </Button>
    </li>
  );
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const FACES_SHOWN = 3;

/**
 * The header of a shared thread: the faces of the people in it, opening Share, and the people
 * chat, marked while guests' messages wait.
 */
export function RoomIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const online = useRoomPresence(threadRef);
  if (room === null) return null;
  const joined = room.participants.flatMap((participant) =>
    participant.name === null ? [] : [{ ...participant, name: participant.name }],
  );
  const waiting = roomWaitingCount(room) > 0;
  const shown = joined.slice(0, FACES_SHOWN);
  const names = joined.map((person) => person.name).join(", ");
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={joined.length === 0 ? "Share: nobody has joined yet" : `Share: ${names}`}
              onClick={() => appAtomRegistry.set(guestShareDialogThreadAtom, threadRef)}
            />
          }
        >
          {shown.length === 0 ? (
            <ShareIcon aria-hidden />
          ) : (
            <span aria-hidden className="flex -space-x-1">
              {shown.map((person) => (
                <span
                  key={person.id}
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border-2 border-background bg-accent text-[9px] font-medium text-foreground",
                    !online.has(person.id) && "opacity-45",
                  )}
                >
                  {initialsOf(person.name)}
                </span>
              ))}
              {joined.length > FACES_SHOWN ? (
                <span className="flex size-5 items-center justify-center rounded-full border-2 border-background bg-muted text-[9px] text-muted-foreground">
                  +{joined.length - FACES_SHOWN}
                </span>
              ) : null}
            </span>
          )}
          Share
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {joined.length === 0 ? "Invited. Nobody has joined yet." : names}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="relative"
              aria-label={waiting ? "Chat, new messages" : "Chat"}
              onClick={() =>
                useRightPanelStore.getState().openScient(threadRef, scientRoomChatSurface())
              }
            />
          }
        >
          <MessagesSquareIcon />
          {waiting ? (
            <span
              aria-hidden
              className="absolute end-0.5 top-0.5 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Chat with people</TooltipPopup>
      </Tooltip>
    </div>
  );
}
