import { useStableCallback } from "~/hooks/useStableCallback";
import type { MessageId, OrchestrationV2RunStatus } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../types";
import { shouldFollowArrivedPrompt } from "./readerScrollPolicy";

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

/**
 * A promoted steer is answered by the receiving run, not its cancelled queued run. Prefer the
 * listed message's actual run, falling back to its initiating run only until that association
 * arrives.
 */
function promptRun(
  promptId: string,
  runs: readonly PromptRun[],
  messages: readonly PromptMessage[],
) {
  const runId = messages.find((message) => message.id === promptId)?.runId;
  const receiving = runId ? runs.find((run) => run.id === runId) : undefined;
  return receiving ?? runs.find((run) => run.userMessageId === promptId);
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
  /** The followed prompt's own run has ended: no more of its response will arrive. */
  readonly settled: boolean;
  /** Changes each time the reader (re)joins the follow at the end. */
  readonly joined: number;
  /** The follow ended (revealed or cancelled by the reader). */
  readonly onFinished: (promptId: string) => void;
  /** A reader came back to a thread they left while following this prompt. */
  readonly onResume: (promptId: string) => void;
  /** The reader arrived at the end: on their own, by Scroll to end, or by opening the thread. */
  readonly onReachedEnd: () => void;
}

interface FollowIntent {
  readonly threadKey: string | null;
  readonly promptId: MessageId;
  readonly joined: number;
}

/**
 * Settle follow from the prompt's own V2 run, never thread-wide busy state. Reader navigation and
 * failed/settled sends end ownership; returning to a thread may resume only the follow left there.
 * A reader arriving at the end of a working thread joins its follow, whoever started the run.
 */
export function useResponseFollow(input: {
  threadKey: string | null;
  /** The thread's V2 runs; none before the projection loads. */
  runs: readonly PromptRun[] | undefined;
  /** The listed messages, including prompts this window has not had confirmed yet. */
  messages: readonly Pick<ChatMessage, "id" | "runId" | "role">[];
  /** Whether `runs` and `messages` are the thread's (the projection has loaded). */
  loaded: boolean;
}) {
  const [intent, setIntent] = useState<FollowIntent | null>(null);
  const runs = input.runs ?? NO_RUNS;
  const latest = useRef({ ...input, runs });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest.current in step with the newest inputs for the stable follow callbacks
  useLayoutEffect(() => {
    latest.current = { ...input, runs };
  });
  const own = intent !== null && intent.threadKey === input.threadKey ? intent : null;
  const state = own
    ? promptResponseState({ promptId: own.promptId, runs, messages: input.messages })
    : null;
  // A prompt whose send failed has nothing left to follow.
  const current = input.loaded && state === "missing" ? null : own;
  /** Follow a prompt's whole response from now; joining the current one again keeps its motion. */
  const start = useStableCallback((promptId: MessageId) => {
    const threadKey = latest.current.threadKey;
    setIntent((existing) => ({ threadKey, promptId, joined: (existing?.joined ?? 0) + 1 }));
  });
  const clear = useStableCallback(() => setIntent(null));
  const onFinished = useStableCallback((promptId: string) => {
    setIntent((existing) => (existing?.promptId === promptId ? null : existing));
  });
  /** The prompt's run is starting or working; one still waiting in the queue is not live yet. */
  const followable = useStableCallback((promptId: string) => {
    const { runs, messages } = latest.current;
    if (promptRun(promptId, runs, messages)?.status === "queued") return false;
    const promptState = promptResponseState({ promptId, runs, messages });
    return promptState === "awaiting" || promptState === "running";
  });
  const onResume = useStableCallback((promptId: string) => {
    if (followable(promptId)) start(promptId as MessageId);
  });
  /** Join the follow of the latest prompt whose run is live. */
  const join = useStableCallback(() => {
    const { runs, messages } = latest.current;
    const prompt = messages.findLast(
      (message) =>
        message.role === "user" && promptRun(message.id, runs, messages)?.status !== "queued",
    );
    if (prompt && followable(prompt.id)) start(prompt.id);
  });
  const settled = state === "settled";
  const timeline = {
    settled,
    joined: current?.joined ?? 0,
    onFinished,
    onResume,
    onReachedEnd: join,
  } satisfies TimelineResponseFollow;
  return { promptId: current?.promptId ?? null, timeline, start, join, followable, clear };
}

/**
 * Follow the thread's latest prompt when it arrives while the reader is at the end, whoever sent
 * it. V2 input intent marks a queued prompt delivered regardless of projection batching or receipt
 * order, so this window's queued send is followed even when its delivery arrives first.
 */
export function useArrivedPromptFollow(input: {
  threadKey: string | null;
  latestPrompt: Pick<ChatMessage, "id" | "inputIntent"> | null;
  /** Read when the prompt arrives, before the timeline measures it. */
  readerAtEnd: () => boolean;
  /** The prompt already followed: this window's own send at the end. */
  followingPromptId: string | null;
  follow: (promptId: MessageId) => void;
}) {
  const { threadKey } = input;
  const callbacks = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps callbacks.current in step with the newest input for the delivery-transition check
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a follow when a queued prompt becomes delivered, reading the at-end position at arrival
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { threadKey, id: latestPromptId, delivered };
    if (
      latestPromptId !== null &&
      latestPromptId !== callbacks.current.followingPromptId &&
      shouldFollowArrivedPrompt({
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
