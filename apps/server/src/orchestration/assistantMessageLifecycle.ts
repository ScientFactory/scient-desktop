// FILE: assistantMessageLifecycle.ts
// Purpose: Centralize assistant-message settlement rules at turn/session boundaries.
// Layer: Server orchestration domain helpers
// Exports: terminal-session settlement and late-delta guards

import type {
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  TurnId,
} from "@synara/contracts";

const TERMINAL_SESSION_STATUSES = new Set<OrchestrationSession["status"]>([
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

export interface AssistantMessagesToSettle {
  readonly turnId: TurnId;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

/**
 * Resolves the turn being closed by a terminal session transition and returns
 * every assistant message that still needs a completion event.
 *
 * Stop-requested flows may temporarily report an interrupted session while
 * retaining an active turn. Those transitions are deliberately excluded until
 * the provider actually clears the active turn.
 */
export function collectAssistantMessagesToSettle(input: {
  readonly thread: OrchestrationThread;
  readonly nextSession: OrchestrationSession;
}): AssistantMessagesToSettle | null {
  if (
    input.nextSession.activeTurnId !== null ||
    !TERMINAL_SESSION_STATUSES.has(input.nextSession.status)
  ) {
    return null;
  }

  const turnId =
    input.thread.session?.activeTurnId ??
    (input.thread.latestTurn?.state === "running" ? input.thread.latestTurn.turnId : null);
  if (turnId === null) {
    return null;
  }

  const messages = input.thread.messages.filter(
    (message) => message.role === "assistant" && message.turnId === turnId && message.streaming,
  );
  return messages.length > 0 ? { turnId, messages } : null;
}

/** A late provider delta may enrich settled text, but must never reopen its turn. */
export function isAssistantTurnTerminal(
  thread: Pick<OrchestrationThread, "latestTurn">,
  turnId: TurnId | null | undefined,
): boolean {
  return (
    turnId != null && thread.latestTurn?.turnId === turnId && thread.latestTurn.state !== "running"
  );
}
