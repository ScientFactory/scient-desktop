import type { ThreadRoom } from "@t3tools/contracts";

/** People are in the thread once someone opened their invite and can still use it. */
export const roomHasPeople = (room: ThreadRoom | null, nowMs: number): room is ThreadRoom =>
  room !== null &&
  room.participants.some(
    (participant) => participant.name !== null && Date.parse(participant.expiresAt) > nowMs,
  );

/**
 * Only a plain new message is for people. A send that steers, uses the alternate or background
 * send, answers the agent's question or approval, edits a queued message, carries a preview
 * annotation, or is a command goes to the agent as it would with nobody in the thread.
 */
export const composerSendIsForPeople = (send: {
  readonly steer: boolean;
  /** The other of steer and queue while the agent runs, or send-and-new-thread. */
  readonly alternate: boolean;
  readonly directPrompt: boolean;
  readonly annotation: boolean;
  readonly queueEdit: boolean;
  readonly answering: boolean;
  readonly prompt: string;
}): boolean =>
  !send.steer &&
  !send.alternate &&
  !send.directPrompt &&
  !send.annotation &&
  !send.queueEdit &&
  !send.answering &&
  !send.prompt.trimStart().startsWith("/");
