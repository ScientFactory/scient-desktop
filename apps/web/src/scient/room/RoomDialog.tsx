import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ROOM_ROLE_DESCRIPTION,
  ROOM_ROLE_LABEL,
  type RoomAccessDuration,
  type RoomParticipant,
  type RoomParticipantId,
  type RoomRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, UsersIcon } from "lucide-react";
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
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/select";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentSubscription } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

const ROLE_LABEL = ROOM_ROLE_LABEL;
const ROLE_DESCRIPTION = ROOM_ROLE_DESCRIPTION;

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

type InviteState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string; readonly participantId: RoomParticipantId }
  | { readonly status: "failed"; readonly message: string };

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

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
  const [state, setState] = useState<InviteState>({ status: "idle" });
  const [closing, setClosing] = useState(false);

  const createInvite = async () => {
    setState({ status: "creating" });
    const result = await invite({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, role, duration },
    });
    if (result._tag === "Success") {
      setState({ status: "created", ...result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "failed", message: failureMessage(result, "Could not create an invite.") });
  };

  const act = (action: Parameters<typeof roomAction>[0]["input"]["action"]) =>
    roomAction({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, action },
    });

  const people = room?.participants ?? [];
  return (
    <Dialog open onOpenChange={(open) => (!open && state.status !== "creating" ? onClose() : null)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>
            People you invite see this thread live, including the agent&apos;s work, and can talk
            with you here. The agent only gets what someone sends to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2" aria-label="New invite">
              <div className="flex items-center gap-2">
                <NativeSelect
                  aria-label="Permission"
                  size="sm"
                  value={role}
                  onChange={(event) => setRole(event.target.value as RoomRole)}
                >
                  {(["watch", "discuss", "agent"] as const).map((value) => (
                    <option key={value} value={value}>
                      {ROLE_LABEL[value]}
                    </option>
                  ))}
                </NativeSelect>
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
                <Button
                  size="sm"
                  disabled={!canInvite || state.status === "creating"}
                  onClick={() => void createInvite()}
                >
                  {state.status === "creating" ? "Creating..." : "Create invite"}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{ROLE_DESCRIPTION[role]}</p>
              {state.status === "created" ? (
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label="Invite link"
                    value={state.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(state.url)}>
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
              {state.status === "created" ? (
                <p className="text-muted-foreground text-xs">
                  This link works for one person. Create another for each person you invite.
                </p>
              ) : null}
              {state.status === "failed" ? (
                <p role="alert" className="text-destructive text-xs">
                  {state.message}
                </p>
              ) : null}
            </section>
            {people.length > 0 ? (
              <ul className="flex flex-col gap-2" aria-label="People in this room">
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
        <DialogFooter>
          {room !== null ? (
            <Button
              variant="destructive-outline"
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
          ) : null}
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
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
  const pending = participant.name === null;
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={
          props.online
            ? "size-2 shrink-0 rounded-full bg-success"
            : "size-2 shrink-0 rounded-full bg-border"
        }
      />
      <span className="min-w-0 flex-1 truncate text-sm">
        {participant.name ?? "Invite not opened yet"}
        <span className="sr-only">{props.online ? ", online" : ""}</span>
        <span className="text-muted-foreground text-xs">
          {" "}
          · until {expiryLabel(participant.expiresAt)}
        </span>
      </span>
      {pending ? (
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={async () => {
            const result = await inviteLink({
              environmentId: props.threadRef.environmentId,
              input: { threadId: props.threadRef.threadId, participantId: participant.id },
            });
            if (result._tag === "Success") copyToClipboard(result.value.url);
          }}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy link"}
        </Button>
      ) : null}
      <span className="w-44 shrink-0">
        <NativeSelect
          aria-label={`Permission of ${participant.name ?? "invited person"}`}
          size="xs"
          value={participant.role}
          disabled={!props.canManage}
          onChange={(event) => props.onRole(event.target.value as RoomRole)}
        >
          {(["watch", "discuss", "agent"] as const).map((value) => (
            <option key={value} value={value}>
              {ROLE_LABEL[value]}
            </option>
          ))}
        </NativeSelect>
      </span>
      <Button
        size="xs"
        variant="ghost-destructive"
        disabled={!props.canManage}
        aria-label={`Remove ${participant.name ?? "invited person"}`}
        onClick={props.onRemove}
      >
        Remove
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
