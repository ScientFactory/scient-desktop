import { GUEST_NAME_MAX_LENGTH, ROOM_PAGE_PARAM, ROOM_PAGE_PATH } from "@t3tools/contracts";
import { useEffect, useReducer, useState, type FormEvent } from "react";

import type { MessagesTimelineHistoryControls } from "~/components/chat/MessagesTimeline";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RoomThread } from "./RoomThread";
import {
  applyRoomStreamEvent,
  initialRoomStreamState,
  parseRoomStreamEvent,
  readRoomEntry,
  roomEndedNotice,
  roomUrl,
} from "./roomGuest.logic";
import { fetchRoomHistory, joinRoom, roomResponseError } from "./roomGuestApi";

export function RoomPage() {
  const [entry, setEntry] = useState(() =>
    readRoomEntry(window.location.search, window.location.hash),
  );
  const [access, setAccess] = useState(entry.participantId === null ? "name" : "checking");
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks this browser's participant cookie before opening its stream and aborts on unmount
  useEffect(() => {
    if (entry.participantId === null) return;
    const controller = new AbortController();
    void fetch(roomUrl("session", entry.participantId), { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) return { access: "session", error: null };
        return {
          access: entry.credential === null ? "none" : "name",
          error: await roomResponseError(response),
        };
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setAccess(result.access);
        setError(result.error);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not reach the server. Try opening this link again.");
        setAccess(entry.credential === null ? "none" : "name");
      });
    return () => controller.abort();
  }, [entry]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a different invite pasted into this tab's fragment must load its own entry
  useEffect(() => {
    const changed = () => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      {access === "checking" ? (
        <Notice message="Connecting…" />
      ) : access === "session" && entry.participantId !== null ? (
        <RoomSession key={entry.participantId} participantId={entry.participantId} />
      ) : access === "name" && entry.credential !== null ? (
        <NameForm
          credential={entry.credential}
          initialError={error}
          onJoined={(participantId) => {
            window.history.replaceState(
              window.history.state,
              "",
              `${ROOM_PAGE_PATH}?${ROOM_PAGE_PARAM}=${encodeURIComponent(participantId)}`,
            );
            setEntry({ participantId, credential: null });
            setAccess("session");
            setError(null);
          }}
        />
      ) : (
        <Notice message={error ?? "This invite link is not valid. Ask the owner for a new link."} />
      )}
    </main>
  );
}

function Notice({ message }: { readonly message: string }) {
  return (
    <p role="status" className="m-auto max-w-sm p-6 text-center text-sm">
      {message}
    </p>
  );
}

function NameForm({
  credential,
  initialError,
  onJoined,
}: {
  readonly credential: string;
  readonly initialError: string | null;
  readonly onJoined: (participantId: string) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (submitting || trimmed === "") return;
    setSubmitting(true);
    try {
      onJoined(await joinRoom(credential, trimmed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join this room. Try again.");
      setSubmitting(false);
    }
  };
  return (
    <form className="m-auto flex w-full max-w-sm flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Join a thread room</h1>
      <label htmlFor="room-name" className="flex flex-col gap-1.5 text-sm">
        Your name
        <Input
          id="room-name"
          autoFocus
          autoComplete="name"
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value.replace(/[\r\n]/g, ""))}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Everyone in the room sees the thread and your name.
      </p>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || name.trim() === ""}>
        Join
      </Button>
    </form>
  );
}

function RoomSession({ participantId }: { readonly participantId: string }) {
  const [stream, dispatch] = useReducer(applyRoomStreamEvent, initialRoomStreamState);
  const [rejected, setRejected] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [historyLoad, setHistoryLoad] = useState<{ cursor: string; error: string | null } | null>(
    null,
  );
  const cursor = stream.thread.historyCursor;
  const currentLoad = historyLoad?.cursor === cursor ? historyLoad : null;
  const loading = currentLoad !== null && currentLoad.error === null;
  const loadEarlier = async () => {
    if (cursor === null || loading) return;
    setHistoryLoad({ cursor, error: null });
    try {
      const page = await fetchRoomHistory(participantId, cursor);
      dispatch({ type: "history-page", cursor, page });
    } catch (cause) {
      setHistoryLoad({
        cursor,
        error: cause instanceof Error ? cause.message : "Could not load earlier turns. Try again.",
      });
    }
  };
  const historyControls: MessagesTimelineHistoryControls | undefined =
    cursor === null
      ? undefined
      : {
          hasMoreHistory: true,
          loading,
          error: currentLoad?.error ?? null,
          onLoadEarlier: () => void loadEarlier(),
        };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- maintains the page title outside React
  useEffect(() => {
    if (stream.view) document.title = stream.view.title;
  }, [stream.view]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the room stream and rechecks the session if SSE is permanently rejected
  useEffect(() => {
    const controller = new AbortController();
    const source = new EventSource(roomUrl("stream", participantId));
    source.addEventListener("message", (message) => {
      const event = parseRoomStreamEvent(message.data);
      if (event === null) return;
      setReconnecting(false);
      dispatch(event);
      if (event.type === "ended") source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED) {
        setReconnecting(true);
        return;
      }
      void fetch(roomUrl("session", participantId), { signal: controller.signal })
        .then(async (response) =>
          response.ok
            ? "The room connection ended. Open this link again to reconnect."
            : roomResponseError(response),
        )
        .then((message) => {
          if (!controller.signal.aborted) setRejected(message);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setRejected("Could not reach the server. Open this link again to reconnect.");
        });
    });
    return () => {
      controller.abort();
      source.close();
    };
  }, [participantId]);

  if (stream.ended !== null) return <Notice message={roomEndedNotice[stream.ended]} />;
  if (rejected !== null) return <Notice message={rejected} />;
  if (stream.view === null || stream.thread.projection === null)
    return <Notice message={reconnecting ? "Reconnecting…" : "Connecting…"} />;
  return (
    <>
      {reconnecting ? (
        <p role="status" className="px-4 py-1 text-xs text-muted-foreground">
          Reconnecting…
        </p>
      ) : null}
      <RoomThread
        view={stream.view}
        projection={stream.thread.projection}
        historyControls={historyControls}
      />
    </>
  );
}
