import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ROOM_ROLE_LABEL,
  type RoomAccessDuration,
  type RoomParticipant,
  type RoomRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, LinkIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { guestShareDialogThreadAtom } from "~/components/chat/guestShareDialogState";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { NativeSelect } from "~/components/ui/select";
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
  const [closing, setClosing] = useState(false);

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

  const people = room?.participants ?? [];
  return (
    <Dialog open onOpenChange={(open) => (!open && !creating ? onClose() : null)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>
            They see this thread live. The agent only gets what someone sends to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2" aria-label="New invite">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <NativeSelect
                    aria-label="Permission"
                    size="sm"
                    value={role}
                    onChange={(event) => setRole(event.target.value as RoomRole)}
                  >
                    {ROLES.map((value) => (
                      <option key={value} value={value}>
                        {ROOM_ROLE_LABEL[value]}
                      </option>
                    ))}
                  </NativeSelect>
                </span>
                <span className="w-28 shrink-0">
                  <NativeSelect
                    aria-label="Access for"
                    size="sm"
                    value={duration}
                    onChange={(event) => setDuration(event.target.value as RoomAccessDuration)}
                  >
                    {(["day", "week", "month"] as const).map((value) => (
                      <option key={value} value={value}>
                        {DURATION_LABEL[value]}
                      </option>
                    ))}
                  </NativeSelect>
                </span>
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={!canInvite || creating}
                  onClick={() => void createInvite()}
                >
                  {isCopied ? <CheckIcon /> : <LinkIcon />}
                  {creating ? "Creating..." : isCopied ? "Link copied" : "Copy invite link"}
                </Button>
              </div>
              {role === "agent" ? (
                <p className="text-muted-foreground text-xs">
                  The agent works on this computer, with your files and accounts.
                </p>
              ) : null}
              {error !== null ? (
                <p role="alert" className="text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </section>
            {people.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label="People in this room">
                {people.map((participant) => (
                  <ParticipantRow
                    key={participant.id}
                    threadRef={threadRef}
                    participant={participant}
                    online={online.has(participant.id)}
                    canManage={canOperate}
                    onRole={(next) =>
                      void act({ type: "set-role", participantId: participant.id, role: next })
                    }
                    onRemove={() => void act({ type: "remove", participantId: participant.id })}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        </DialogPanel>
        {room !== null ? (
          <DialogFooter>
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={!canOperate || closing}
              onClick={async () => {
                setClosing(true);
                await act({ type: "close" });
                setClosing(false);
              }}
            >
              Stop sharing
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ParticipantRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly participant: RoomParticipant;
  readonly online: boolean;
  readonly canManage: boolean;
  readonly onRole: (role: RoomRole) => void;
  readonly onRemove: () => void;
}) {
  const { participant } = props;
  const inviteLink = useAtomCommand(serverEnvironment.threadRoomInviteLink, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "invite link" });
  const name = participant.name ?? "Invited";
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", props.online ? "bg-success" : "bg-border")}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                participant.name === null && "text-muted-foreground",
              )}
            />
          }
        >
          {name}
          <span className="sr-only">{props.online ? ", here now" : ""}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Access until {expiryLabel(participant.expiresAt)}</TooltipPopup>
      </Tooltip>
      <span className="w-48 shrink-0">
        <NativeSelect
          aria-label={`Permission of ${name}`}
          size="xs"
          value={participant.role}
          disabled={!props.canManage}
          onChange={(event) => props.onRole(event.target.value as RoomRole)}
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {ROOM_ROLE_LABEL[value]}
            </option>
          ))}
        </NativeSelect>
      </span>
      {participant.name === null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Copy invite link again"
          onClick={async () => {
            const result = await inviteLink({
              environmentId: props.threadRef.environmentId,
              input: { threadId: props.threadRef.threadId, participantId: participant.id },
            });
            if (result._tag === "Success") copyToClipboard(result.value.url);
          }}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      ) : null}
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

/** The header's room status: who is in it, opening the dialog. */
export function RoomIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const room = useQuietThreadProjection(threadRef)?.projection.thread.room ?? null;
  const online = useRoomPresence(threadRef);
  if (room === null) return null;
  const joined = room.participants.filter((participant) => participant.name !== null);
  const here = joined.filter((participant) => online.has(participant.id)).length;
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      className="shrink-0"
      onClick={() => appAtomRegistry.set(guestShareDialogThreadAtom, threadRef)}
    >
      <UsersIcon aria-hidden />
      {joined.length === 0
        ? "Invited"
        : `${joined.length} ${joined.length === 1 ? "person" : "people"}${here > 0 ? `, ${here} here` : ""}`}
    </Button>
  );
}
