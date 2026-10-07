import type { MessageId, OrchestrationV2RunStatus } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../types";
import { shouldRevealArrivedPrompt } from "./readerScrollPolicy";

/**
 * Where a sent prompt's own V2 run is: not started yet (sent, queued,
 * preparing or starting), running (or waiting on the reader), or settled
 * (ended in any way). "missing" is a prompt that left the thread without a
 * run: its send failed.
 */
export type PromptResponseState = "awaiting" | "running" | "settled" | "missing";

interface PromptRun {
  readonly id: string;
  readonly userMessageId: string;
  readonly status: OrchestrationV2RunStatus;
}
type PromptMessage = Pick<ChatMessage, "id" | "runId">;
const NO_RUNS: readonly PromptRun[] = [];

/** The run a prompt started (its userMessageId), or the run it steered (its runId). */
function promptRun(
  promptId: string,
  runs: readonly PromptRun[],
  messages: readonly PromptMessage[],
) {
  const started = runs.find((run) => run.userMessageId === promptId);
  if (started) return started;
  const runId = messages.find((message) => message.id === promptId)?.runId;
  return runId ? runs.find((run) => run.id === runId) : undefined;
}

export function promptResponseState(input: {
  promptId: string;
  runs: readonly PromptRun[];
  messages: readonly PromptMessage[];
}): PromptResponseState {
  const run = promptRun(input.promptId, input.runs, input.messages);
  if (!run) {
    return input.messages.some((message) => message.id === input.promptId) ? "awaiting" : "missing";
  }
  switch (run.status) {
    case "queued":
    case "preparing":
    case "starting":
      return "awaiting";
    case "running":
    case "waiting":
      return "running";
    default:
      return "settled";
  }
}

/** Whether the prompt's own run has been admitted and is still starting up. */
export function promptRunStarting(input: {
  promptId: string | null;
  runs: readonly PromptRun[];
  messages: readonly PromptMessage[];
}): boolean {
  if (input.promptId === null) return false;
  const status = promptRun(input.promptId, input.runs, input.messages)?.status;
  return status === "preparing" || status === "starting";
}

/** What the timeline needs to run the follow ChatView owns. */
export interface TimelineResponseFollow {
  /** A later prompt: follow its whole response to the end, not only its answer. */
  readonly followsResponse: boolean;
  /** The followed prompt's own run has ended: no more of its response will arrive. */
  readonly settled: boolean;
  /** The follow ended (revealed or cancelled by the reader). */
  readonly onFinished: (promptId: string) => void;
  /** A reader came back to a thread they left while following this prompt. */
  readonly onResume: (promptId: string) => void;
}

interface FollowIntent {
  readonly threadKey: string | null;
  readonly promptId: MessageId;
  readonly followsResponse: boolean;
}

/**
 * The one owner of the send follow: which prompt's response the view
 * follows in this thread, if any. A send at the end, a queued delivery at
 * the end, and a reader coming back to a thread they left while following
 * start it; scrolling up, Scroll to end, a thread switch, the response
 * settling, or the prompt's send failing end it. Settling is judged from the
 * prompt's own V2 run, never from the thread looking busy.
 */
export function useResponseFollow(input: {
  threadKey: string | null;
  /** The thread's V2 runs; none before the projection loads. */
  runs: readonly PromptRun[] | undefined;
  /** The listed messages, including prompts this window has not had confirmed yet. */
  messages: readonly PromptMessage[];
  /** Whether `runs` and `messages` are the thread's (the projection has loaded). */
  loaded: boolean;
}) {
  const [intent, setIntent] = useState<FollowIntent | null>(null);
  const runs = input.runs ?? NO_RUNS;
  const latest = useRef({ ...input, runs });
  useLayoutEffect(() => {
    latest.current = { ...input, runs };
  });
  const own = intent !== null && intent.threadKey === input.threadKey ? intent : null;
  const state = own
    ? promptResponseState({ promptId: own.promptId, runs, messages: input.messages })
    : null;
  // A prompt whose send failed has nothing left to follow.
  const current = input.loaded && state === "missing" ? null : own;
  const start = useCallback((promptId: MessageId, followsResponse: boolean) => {
    setIntent({ threadKey: latest.current.threadKey, promptId, followsResponse });
  }, []);
  const clear = useCallback(() => setIntent(null), []);
  const onFinished = useCallback((promptId: string) => {
    setIntent((existing) => (existing?.promptId === promptId ? null : existing));
  }, []);
  const onResume = useCallback((promptId: string) => {
    const { threadKey, runs, messages } = latest.current;
    const resumedState = promptResponseState({ promptId, runs, messages });
    if (resumedState === "awaiting" || resumedState === "running")
      setIntent({ threadKey, promptId: promptId as MessageId, followsResponse: true });
  }, []);
  const followsResponse = current?.followsResponse ?? false;
  const settled = state === "settled";
  const timeline = useMemo<TimelineResponseFollow>(
    () => ({ followsResponse, settled, onFinished, onResume }),
    [followsResponse, settled, onFinished, onResume],
  );
  return { promptId: current?.promptId ?? null, timeline, start, clear };
}

/**
 * A queued prompt the server delivers while the reader is at the end gets the
 * same follow as a send. Delivery is V2's own word for it (the delivered
 * prompt's input intent), so it holds however the projection's updates were
 * batched, and whichever of the send's receipt and the delivery comes first:
 * the decision runs again when the latest prompt becomes a delivered one.
 */
export function useQueuedDeliveryFollow(input: {
  threadKey: string | null;
  latestPrompt: Pick<ChatMessage, "id" | "inputIntent"> | null;
  /** Read when the prompt arrives, before the timeline measures it. */
  readerAtEnd: () => boolean;
  follow: (promptId: MessageId) => void;
}) {
  const { threadKey } = input;
  const callbacks = useRef(input);
  useLayoutEffect(() => {
    callbacks.current = input;
  });
  const latestPromptId = input.latestPrompt?.id ?? null;
  const delivered =
    input.latestPrompt?.inputIntent === "queued_turn" ||
    input.latestPrompt?.inputIntent === "promoted_queued_to_steer";
  const previousRef = useRef<{
    threadKey: string | null;
    id: string | null;
    delivered: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { threadKey, id: latestPromptId, delivered };
    if (
      latestPromptId !== null &&
      shouldRevealArrivedPrompt({
        previous,
        threadKey,
        latestPromptId,
        delivered,
        readerAtEnd: callbacks.current.readerAtEnd(),
      })
    )
      callbacks.current.follow(latestPromptId as MessageId);
  }, [threadKey, latestPromptId, delivered]);
}
