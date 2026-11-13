import type {
  EnvironmentId,
  LiveVoiceCallEvent,
  LiveVoicePhase,
  ThreadId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command.ts";
import { getVoiceBridge } from "../voice/voiceClient.ts";
import { acquireCurrentMicrophone } from "../voice/voiceMedia.ts";
import { describeMicrophoneAccessRefusal } from "../voice/useScientVoiceController.ts";
import { liveVoiceCallCommand, liveVoiceMuteCommand } from "./liveVoiceCommands.ts";
import { type LiveVoicePeer, openLiveVoicePeer } from "./liveVoicePeer.ts";

export interface LiveVoiceLine {
  readonly role: "user" | "assistant";
  readonly turn: number;
  readonly text: string;
}

export type LiveVoiceCallState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | {
      readonly status: "active";
      readonly phase: LiveVoicePhase;
      readonly muted: boolean;
      /** The latest spoken line, the user's or the agent's. */
      readonly line: LiveVoiceLine | null;
    }
  | { readonly status: "failed"; readonly message: string };

const LEVELS_INTERVAL_MS = 100;

interface Call {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly abort: AbortController;
  peer?: LiveVoicePeer;
}

/** The failure's own message when it has one, else a plain one. */
const describeFailure = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (reason._tag !== "Fail") continue;
    const error = reason.error;
    if (error instanceof Error && error.message) return error.message;
  }
  return "The voice call couldn't continue.";
};

/**
 * Runs one call until it ends: microphone, peer and server stream. Returns why it failed, or null
 * when it ended normally or was hung up. Always releases the microphone and the peer.
 */
async function runLiveVoiceCall(input: {
  readonly call: Call;
  readonly current: () => boolean;
  readonly setState: Dispatch<SetStateAction<LiveVoiceCallState>>;
  readonly connect: (
    sdpOffer: string,
    onEvent: (event: LiveVoiceCallEvent) => void,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<string | null> {
  const { call, current, setState } = input;
  let microphone: MediaStream | null = null;
  try {
    const access = await getVoiceBridge()
      ?.requestMicrophoneAccess?.()
      .catch(() => "unavailable" as const);
    if (access === "denied" || access === "restricted") {
      return describeMicrophoneAccessRefusal(access, window.desktopBridge?.getClientPlatform?.());
    }
    microphone = await acquireCurrentMicrophone(navigator.mediaDevices, current);
    if (!microphone) return null;
    const peer = await openLiveVoicePeer(microphone);
    call.peer = peer;
    if (!current()) return null;
    let ended: string | undefined;
    const result = await input.connect(peer.offer, (event) => {
      if (!current()) return;
      switch (event.type) {
        case "answer":
          setState({ status: "active", phase: "connecting", muted: false, line: null });
          void peer.applyAnswer(event.sdpAnswer).catch(() => {
            ended = "The call's audio couldn't connect.";
            call.abort.abort();
          });
          return;
        case "phase":
          setState((previous) =>
            previous.status === "active" ? { ...previous, phase: event.phase } : previous,
          );
          return;
        case "transcript":
          if (!event.text.trim()) return;
          setState((previous) =>
            previous.status === "active"
              ? { ...previous, line: { role: event.role, turn: event.turn, text: event.text } }
              : previous,
          );
          return;
        case "request":
          return;
        case "ended":
          ended = event.error;
          return;
      }
    });
    if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause)) {
      return describeFailure(result.cause);
    }
    return ended ?? null;
  } catch (cause) {
    return cause instanceof DOMException && cause.name === "NotAllowedError"
      ? describeMicrophoneAccessRefusal("denied", window.desktopBridge?.getClientPlatform?.())
      : cause instanceof Error && cause.message
        ? cause.message
        : "The voice call couldn't start.";
  } finally {
    call.peer?.close();
    for (const track of microphone?.getTracks() ?? []) track.stop();
  }
}

/**
 * One voice call with the thread's Scient Agent. Leaving the thread or closing the window
 * hangs up.
 */
export function useScientLiveVoiceCall(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const runCall = useAtomCommand(liveVoiceCallCommand, { reportFailure: false });
  const runMute = useAtomCommand(liveVoiceMuteCommand, { reportFailure: false });
  const [state, setState] = useState<LiveVoiceCallState>({ status: "idle" });
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const callRef = useRef<Call | null>(null);
  const { environmentId: currentEnvironmentId, threadId: currentThreadId } = input;

  const hangUp = () => {
    callRef.current?.abort.abort();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the WebRTC call and its server stream belong to one thread; leaving it or unmounting hangs up.
  useEffect(
    () => () => {
      const call = callRef.current;
      if (
        call &&
        call.environmentId === currentEnvironmentId &&
        call.threadId === currentThreadId
      ) {
        call.abort.abort();
      }
    },
    [currentEnvironmentId, currentThreadId],
  );

  const active = state.status === "active";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the call's audio analysers, which live outside React, while the call is up.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const peer = callRef.current?.peer;
      if (peer) setLevels(peer.levels());
    }, LEVELS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      setLevels({ input: 0, output: 0 });
    };
  }, [active]);

  const start = async (): Promise<void> => {
    const { environmentId, threadId } = input;
    if (!environmentId || !threadId || callRef.current) return;
    const call: Call = { environmentId, threadId, abort: new AbortController() };
    callRef.current = call;
    setState({ status: "starting" });
    const failure = await runLiveVoiceCall({
      call,
      current: () => callRef.current === call && !call.abort.signal.aborted,
      setState,
      connect: (sdpOffer, onEvent) =>
        runCall({ environmentId, threadId, sdpOffer, signal: call.abort.signal, onEvent }),
    });
    if (callRef.current !== call) return;
    callRef.current = null;
    const userHungUp = call.abort.signal.aborted && failure === null;
    setState(
      failure !== null && !userHungUp ? { status: "failed", message: failure } : { status: "idle" },
    );
  };

  const setMuted = (muted: boolean) => {
    const { environmentId, threadId } = input;
    const peer = callRef.current?.peer;
    if (!peer || !environmentId || !threadId) return;
    peer.setMuted(muted);
    setState((previous) => (previous.status === "active" ? { ...previous, muted } : previous));
    // The agent's mute only changes the phase it reports; the audio is muted here.
    void runMute({ environmentId, input: { threadId, muted } });
  };

  const dismiss = () => {
    setState((previous) => (previous.status === "failed" ? { status: "idle" } : previous));
  };

  return { state, levels, start, hangUp, setMuted, dismiss };
}

export type ScientLiveVoiceCall = ReturnType<typeof useScientLiveVoiceCall>;
