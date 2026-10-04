/** How long the timeline keeps showing a sent turn that no session has picked up yet. */
export const TURN_START_BRIDGE_MS = 15_000;

/**
 * Whether the timeline shows the thread working. A send turns busy before its
 * prompt is in the list, and the server acknowledges it before a session picks
 * the turn up. The working row must neither appear ahead of the prompt (and
 * then jump below it) nor drop out and come back in that gap.
 */
export function resolveTimelineWorking(input: {
  isWorking: boolean;
  /** Busy only because a send is being dispatched: no session work, setup or other cause. */
  onlySendBusy: boolean;
  /** The prompt of the send being dispatched is in the list. */
  sentPromptShown: boolean;
  /** A send was acknowledged and its turn is not picked up yet. */
  awaitingTurnStart: boolean;
}): boolean {
  if (input.isWorking) return !(input.onlySendBusy && !input.sentPromptShown);
  return input.awaitingTurnStart;
}

/** What the timeline remembers about the latest send, to bridge its turn's start. */
export interface TurnStartWait {
  readonly threadKey: string | null;
  readonly sendBusy: boolean;
  /** When the latest send's dispatch started. */
  readonly sendStartedAt: string | null;
  readonly turnCompletedAt: string | null;
  /** The send was acknowledged and no session has picked its turn up yet. */
  readonly awaiting: boolean;
}

/**
 * The next send state. A send that stops being busy while no session runs,
 * without failing or its turn settling, waits for its turn to start; the wait
 * ends once a session works, a turn settles, a send fails or another starts,
 * or the thread changes. Returns `previous` itself when nothing changed.
 */
export function nextTurnStartWait(
  previous: TurnStartWait,
  input: {
    threadKey: string | null;
    sendBusy: boolean;
    sendStartedAt: string | null;
    turnCompletedAt: string | null;
    sessionWorking: boolean;
    failed: boolean;
  },
): TurnStartWait {
  if (previous.threadKey !== input.threadKey)
    return {
      threadKey: input.threadKey,
      sendBusy: input.sendBusy,
      sendStartedAt: input.sendStartedAt,
      turnCompletedAt: input.turnCompletedAt,
      awaiting: false,
    };
  const sendStartedAt = input.sendBusy
    ? (input.sendStartedAt ?? previous.sendStartedAt)
    : previous.sendStartedAt;
  // A turn that completed since the send started (even in an earlier render) settled it.
  const settled =
    input.turnCompletedAt !== previous.turnCompletedAt ||
    (input.turnCompletedAt !== null &&
      sendStartedAt !== null &&
      input.turnCompletedAt >= sendStartedAt);
  const ends = input.sessionWorking || input.failed || input.sendBusy || settled;
  const awaiting =
    (previous.sendBusy && !input.sendBusy && !input.sessionWorking && !input.failed && !settled) ||
    (previous.awaiting && !ends);
  if (
    previous.sendBusy === input.sendBusy &&
    previous.sendStartedAt === sendStartedAt &&
    previous.turnCompletedAt === input.turnCompletedAt &&
    previous.awaiting === awaiting
  )
    return previous;
  return {
    threadKey: input.threadKey,
    sendBusy: input.sendBusy,
    sendStartedAt,
    turnCompletedAt: input.turnCompletedAt,
    awaiting,
  };
}
