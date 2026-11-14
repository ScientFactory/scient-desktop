import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ROOM_ROLE_LABEL,
  roomPeople,
  type RoomAccessDuration,
  type RoomParticipant,
  type RoomRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, RotateCwIcon, UsersIcon, XIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
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
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentSubscription } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { RoomFaces } from "./RoomFaces";

const DURATION_LABEL: Record<RoomAccessDuration, string> = {
  day: "1 day",
  week: "7 days",
  month: "30 days",
};

const expiryLabel = (expiresAt: string) =>
  new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Which thread has its People dialog open. */
const roomPeopleThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-room:people-dialog"),
);

function useRoomPresence(threadRef: ScopedThreadRef): ReadonlySet<string> {
  const presence = useEnvironmentSubscription(
    serverEnvironment.threadRoomPresence({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  return new Set(presence.data?.online ?? []);
}

/** Renders the Share and People dialogs for the thread they were opened for. */
export function RoomDialogHost() {
  const shareRef = useAtomValue(guestShareDialogThreadAtom);
  const peopleRef = useAtomValue(roomPeopleThreadAtom);
  return (
    <>
      {shareRef === null ? null : (
        <ShareDialog
          key={`${shareRef.environmentId}:${shareRef.threadId}`}
          threadRef={shareRef}
          onClose={() => appAtomRegistry.set(guestShareDialogThreadAtom, null)}
        />
      )}
      {peopleRef === null ? null : (
        <PeopleDialog
          key={`${peopleRef.environmentId}:${peopleRef.threadId}`}
          threadRef={peopleRef}
          onClose={() => appAtomRegistry.set(roomPeopleThreadAtom, null)}
        />
      )}
    </>
  );
}

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

// "watch" stays readable for rooms made before; new invites chat at least.
const ROLES = ["discuss", "agent"] as const;
const DURATIONS = ["day", "week", "month"] as const;

/** Share makes a link: what the person can do, for how long, and Copy link. */
function ShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const canInvite = useAtomValue(
    serverEnvironment.inviteToThreadRoom.permissionAtom(threadRef.environmentId),
  );
  const invite = useAtomCommand(serverEnvironment.inviteToThreadRoom, { reportFailure: false });
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

  return (
    <Dialog open onOpenChange={(open) => (!open && !creating ? onClose() : null)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>Each link lets one person follow this thread live.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2">
            <RolePicker label="Permission" size="sm" value={role} onChange={setRole} />
            <Select
              value={duration}
              onValueChange={(next) => setDuration(next as RoomAccessDuration)}
            >
              <SelectTrigger size="sm" className="w-24 min-w-0 shrink-0" aria-label="Access for">
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
            <p role="alert" className="mt-2 text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** People shows who is in the thread and what each may do, for how long. */
function PeopleDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const online = useRoomPresence(threadRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, { label: "room" });
  const act = (action: Parameters<typeof roomAction>[0]["input"]["action"]) =>
    roomAction({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, action },
    });
  const joined = (room?.participants ?? []).filter((participant) => participant.name !== null);
  const unopened = (room?.participants ?? []).filter((participant) => participant.name === null);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription>
            {joined.length === 0
              ? "Nobody has joined yet."
              : "Changes apply at once. Removing everyone stops sharing."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-1" aria-label="People in this thread">
            {joined.map((participant) => (
              <ParticipantRow
                key={participant.id}
                participant={participant}
                online={online.has(participant.id)}
                canManage={canOperate}
                onRole={(next) =>
                  void act({ type: "set-role", participantId: participant.id, role: next })
                }
                onRenew={(duration) =>
                  void act({ type: "renew", participantId: participant.id, duration })
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
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** What someone may do: Can chat or Can use agent. */
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
  readonly onRenew: (duration: RoomAccessDuration) => void;
  readonly onRemove: () => void;
}) {
  const { participant } = props;
  const name = participant.name ?? "Invited";
  const nowMinute = useNowMinute();
  const expired = Date.parse(participant.expiresAt) <= Date.parse(`${nowMinute}Z`);
  return (
    <li className="flex h-7 items-center gap-2">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", props.online ? "bg-success" : "bg-border")}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn("min-w-0 flex-1 truncate text-sm", expired && "text-muted-foreground")}
            />
          }
        >
          {name}
          {expired ? <span className="text-muted-foreground"> · Expired</span> : null}
          <span className="sr-only">{props.online ? ", here now" : ""}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {expired ? "Access ended" : "Access until"} {expiryLabel(participant.expiresAt)}
        </TooltipPopup>
      </Tooltip>
      <RolePicker
        label={`Permission of ${name}`}
        size="xs"
        value={participant.role}
        disabled={!props.canManage}
        onChange={props.onRole}
      />
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!props.canManage}
                    aria-label={`Renew ${name}'s access`}
                  />
                }
              />
            }
          >
            <RotateCwIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Renew access</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" className="w-max min-w-28">
          <MenuGroup>
            <MenuGroupLabel>Renew from now for</MenuGroupLabel>
            {DURATIONS.map((value) => (
              <MenuItem key={value} onClick={() => props.onRenew(value)}>
                {DURATION_LABEL[value]}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!props.canManage}
              aria-label={`Remove ${name}`}
              onClick={props.onRemove}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Remove</TooltipPopup>
      </Tooltip>
    </li>
  );
}

/**
 * The faces of the people in a shared thread, beside Share in its header; they open People.
 * With only unopened links, a people icon stands in for the faces.
 */
export function RoomPeopleButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const online = useRoomPresence(threadRef);
  if (room === null || room.participants.length === 0) return null;
  const joined = roomPeople(room);
  const names = joined.map((person) => person.name).join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            aria-label={joined.length === 0 ? "People: nobody has joined yet" : `People: ${names}`}
            onClick={() => appAtomRegistry.set(roomPeopleThreadAtom, threadRef)}
          />
        }
      >
        {joined.length === 0 ? (
          <UsersIcon aria-hidden />
        ) : (
          <RoomFaces people={joined} online={online} />
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {joined.length === 0 ? "Invited. Nobody has joined yet." : names}
      </TooltipPopup>
    </Tooltip>
  );
}
