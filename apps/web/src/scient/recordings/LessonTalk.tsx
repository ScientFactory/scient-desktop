import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { transcriptionCommand } from "../../rpc/transcription";
import {
  scientAgentChatGptSignedIn,
  liveVoiceCallInstance,
} from "../liveVoice/liveVoiceAvailability";
import { openLiveVoicePeer, type LiveVoicePeer } from "../liveVoice/liveVoicePeer";
import { useScientLiveVoiceCall } from "../liveVoice/useScientLiveVoiceCall";

/** Who answers a spoken question: ChatGPT through Scient Agent, or OpenAI with the user's key. */
export type LessonTalkRoute =
  | { readonly kind: "chatgpt"; readonly instanceId: ProviderInstanceId }
  | { readonly kind: "openai" };

/** The Scient Agent that can hold a call of its own with the user's ChatGPT sign-in. */
export function lessonTalkAgent(providers: readonly ServerProvider[] | undefined) {
  for (const provider of providers ?? []) {
    if (!provider.enabled || provider.driver !== "scient") continue;
    if (scientAgentChatGptSignedIn(provider) !== true) continue;
    const instanceId = liveVoiceCallInstance(provider);
    if (instanceId) return instanceId;
  }
  return null;
}

type Phase = "connecting" | "listening" | "working" | "speaking";

function PhaseLine({ phase, line }: { readonly phase: Phase; readonly line: string | null }) {
  const gt = useGT();
  const label = {
    connecting: gt("Connecting…"),
    listening: gt("Listening", { $context: "voice call status" }),
    working: gt("Thinking", { $context: "voice call status" }),
    speaking: gt("Speaking", { $context: "voice call status" }),
  }[phase];
  return (
    <div className="space-y-1 py-1">
      <p role="status" className="text-sm font-medium">
        {label}
      </p>
      {line ? <p className="line-clamp-3 text-sm text-muted-foreground">{line}</p> : null}
    </div>
  );
}

/** A question to ChatGPT, in the lesson's own thread, which reads the live captions. */
function ChatGptTalk(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly onEnded: (error?: string) => void;
}) {
  const call = useScientLiveVoiceCall(props);
  const hangUp = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { onEnded } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the call starts when the question opens and hangs up when it closes.
  useEffect(() => {
    // A remount at once, as React's checks do, keeps the call; `start` joins a running one.
    clearTimeout(hangUp.current);
    void call.start();
    return () => {
      hangUp.current = setTimeout(() => call.hangUp(), 0);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one call per question.
  }, []);
  const { state } = call;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a failed call ends the question.
  useEffect(() => {
    if (state.status === "failed") onEnded(state.message);
  }, [state, onEnded]);
  const phase: Phase =
    state.status === "active" && state.phase !== "muted" && state.phase !== "error"
      ? state.phase
      : "connecting";
  const line = state.status === "active" && state.line ? state.line.text : null;
  return <PhaseLine phase={phase} line={line} />;
}

/** A question to OpenAI's realtime model with the user's key, placed by the server. */
function OpenAiTalk(props: {
  readonly project: string;
  readonly captureId: string;
  readonly stream: MediaStream;
  readonly onEnded: (error?: string) => void;
}) {
  const gt = useGT();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [line, setLine] = useState<string | null>(null);
  const { onEnded } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the call lives while the question is open.
  useEffect(() => {
    let closed = false;
    let peer: LiveVoicePeer | undefined;
    // The call hears the lesson's microphone through its own copy, so muting it never mutes the
    // recording.
    const microphone = new MediaStream(props.stream.getAudioTracks().map((track) => track.clone()));
    let answer = "";
    const onEvent = (event: unknown) => {
      if (closed || typeof event !== "object" || event === null) return;
      const { type, delta } = event as { type?: unknown; delta?: unknown };
      if (type === "input_audio_buffer.speech_started") setPhase("listening");
      else if (type === "response.created") {
        answer = "";
        setPhase("working");
      } else if (type === "output_audio_buffer.started") setPhase("speaking");
      else if (type === "output_audio_buffer.stopped") setPhase("listening");
      else if (type === "response.output_audio_transcript.delta" && typeof delta === "string") {
        answer += delta;
        setLine(answer);
      } else if (type === "error") onEnded(gt("The conversation stopped."));
    };
    void (async () => {
      try {
        peer = await openLiveVoicePeer(microphone, onEvent);
        if (closed) return peer.close();
        const { sdpAnswer } = await transcriptionCommand("capture-talk", props.project, {
          id: props.captureId,
          sdpOffer: peer.offer,
        });
        if (closed) return;
        await peer.applyAnswer(sdpAnswer);
        setPhase("listening");
      } catch {
        if (!closed) onEnded(gt("Could not start the conversation."));
      }
    })();
    return () => {
      closed = true;
      peer?.close();
      for (const track of microphone.getTracks()) track.stop();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one call per question.
  }, []);
  return <PhaseLine phase={phase} line={line} />;
}

/** The question being asked while the lesson is paused; unmounting hangs up. */
export function LessonTalk(props: {
  readonly route: LessonTalkRoute;
  readonly environmentId: EnvironmentId;
  readonly project: string;
  readonly captureId: string;
  readonly threadId: ThreadId | null;
  readonly stream: MediaStream;
  readonly onEnded: (error?: string) => void;
}) {
  if (props.route.kind === "openai")
    return (
      <OpenAiTalk
        project={props.project}
        captureId={props.captureId}
        stream={props.stream}
        onEnded={props.onEnded}
      />
    );
  if (!props.threadId) return <PhaseLine phase="connecting" line={null} />;
  return (
    <ChatGptTalk
      environmentId={props.environmentId}
      threadId={props.threadId}
      instanceId={props.route.instanceId}
      onEnded={props.onEnded}
    />
  );
}
