import type {
  EnvironmentId,
  LiveVoiceCallEvent,
  LiveVoicePhase,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { type SetStateAction, useEffect, useState, useSyncExternalStore } from "react";

import { useAtomCommand } from "../../state/use-atom-command.ts";
import { getVoiceBridge } from "../voice/voiceClient.ts";
import { acquireCurrentMicrophone } from "../voice/voiceMedia.ts";
import { describeMicrophoneAccessRefusal } from "../voice/useScientVoiceController.ts";
import {
  deliverVoiceTranscriptToDraft,
  type VoiceDraftOrigin,
} from "../voice/voiceDraftDelivery.ts";
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
/**
 * How long a call outlives its last composer. Sending a new conversation's first message swaps
 * the draft's composer for the conversation's; leaving the conversation hangs up.
 */
const LEAVE_GRACE_MS = 2_000;

interface Call {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly abort: AbortController;
  /** The draft a request goes to while its conversation does not exist yet. */
  readonly draftOrigin: VoiceDraftOrigin | null;
  peer?: LiveVoicePeer;
}

/** A conversation's call, kept outside React so it survives its composer being replaced. */
interface CallSlot {
  call: Call | null;
  state: LiveVoiceCallState;
  owners: number;
  hangUpTimer: ReturnType<typeof setTimeout> | undefined;
  readonly listeners: Set<() => void>;
}

const IDLE: LiveVoiceCallState = { status: "idle" };
const slots = new Map<string, CallSlot>();

const slotKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

function slotFor(key: string): CallSlot {
  let slot = slots.get(key);
  if (slot === undefined) {
    slot = { call: null, state: IDLE, owners: 0, hangUpTimer: undefined, listeners: new Set() };
    slots.set(key, slot);
  }
  return slot;
}

function setSlotState(slot: CallSlot, update: SetStateAction<LiveVoiceCallState>): void {
  const next = typeof update === "function" ? update(slot.state) : update;
  if (next === slot.state) return;
  slot.state = next;
  for (const listener of slot.listeners) listener();
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
  readonly setState: (update: SetStateAction<LiveVoiceCallState>) => void;
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
          // The conversation does not exist yet: its first message, sent like a typed one, creates it.
          if (event.send && call.draftOrigin) {
            deliverVoiceTranscriptToDraft(call.draftOrigin, event.text, true);
          }
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
 * One voice call with Scient Agent for a conversation, or a draft that becomes one. With
 * `instanceId` the call runs in an agent of its own, so it needs no running conversation. Leaving
 * the conversation or closing the window hangs up.
 */
export function useScientLiveVoiceCall(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
  readonly instanceId?: ProviderInstanceId | null | undefined;
}) {
  const runCall = useAtomCommand(liveVoiceCallCommand, { reportFailure: false });
  const runMute = useAtomCommand(liveVoiceMuteCommand, { reportFailure: false });
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const { environmentId, threadId } = input;
  const key = environmentId && threadId ? slotKey(environmentId, threadId) : null;
  const state = useSyncExternalStore(
    (listener) => {
      if (key === null) return () => {};
      const { listeners } = slotFor(key);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key === null ? IDLE : (slots.get(key)?.state ?? IDLE)),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a call belongs to the composers showing its conversation; when the last one goes and none replaces it, it hangs up.
  useEffect(() => {
    if (key === null) return;
    const slot = slotFor(key);
    slot.owners += 1;
    clearTimeout(slot.hangUpTimer);
    return () => {
      slot.owners -= 1;
      if (slot.owners > 0) return;
      slot.hangUpTimer = setTimeout(() => {
        if (slot.owners === 0) slot.call?.abort.abort();
      }, LEAVE_GRACE_MS);
    };
  }, [key]);

  const active = state.status === "active";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the call's audio analysers, which live outside React, while the call is up.
  useEffect(() => {
    if (!active || key === null) return;
    const timer = setInterval(() => {
      const peer = slots.get(key)?.call?.peer;
      if (peer) setLevels(peer.levels());
    }, LEVELS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      setLevels({ input: 0, output: 0 });
    };
  }, [active, key]);

  /** Starts the call; `draftOrigin` receives the first request of a conversation not created yet. */
  const start = async (draftOrigin: VoiceDraftOrigin | null = null): Promise<void> => {
    if (!environmentId || !threadId || key === null) return;
    const slot = slotFor(key);
    if (slot.call) return;
    const call: Call = { environmentId, threadId, abort: new AbortController(), draftOrigin };
    const instanceId = input.instanceId ?? undefined;
    slot.call = call;
    setSlotState(slot, { status: "starting" });
    const failure = await runLiveVoiceCall({
      call,
      current: () => slot.call === call && !call.abort.signal.aborted,
      setState: (update) => {
        if (slot.call === call) setSlotState(slot, update);
      },
      connect: (sdpOffer, onEvent) =>
        runCall({
          environmentId,
          threadId,
          sdpOffer,
          ...(instanceId ? { instanceId } : {}),
          signal: call.abort.signal,
          onEvent,
        }),
    });
    if (slot.call !== call) return;
    slot.call = null;
    const userHungUp = call.abort.signal.aborted && failure === null;
    setSlotState(
      slot,
      failure !== null && !userHungUp ? { status: "failed", message: failure } : IDLE,
    );
  };

  const hangUp = () => {
    if (key !== null) slots.get(key)?.call?.abort.abort();
  };

  const setMuted = (muted: boolean) => {
    const slot = key === null ? undefined : slots.get(key);
    const peer = slot?.call?.peer;
    if (!slot || !peer || !environmentId || !threadId) return;
    peer.setMuted(muted);
    setSlotState(slot, (previous) =>
      previous.status === "active" ? { ...previous, muted } : previous,
    );
    // The agent's mute only changes the phase it reports; the audio is muted here.
    void runMute({ environmentId, input: { threadId, muted } });
  };

  const dismiss = () => {
    const slot = key === null ? undefined : slots.get(key);
    if (slot) setSlotState(slot, (previous) => (previous.status === "failed" ? IDLE : previous));
  };

  return { state, levels, start, hangUp, setMuted, dismiss };
}

export type ScientLiveVoiceCall = ReturnType<typeof useScientLiveVoiceCall>;
