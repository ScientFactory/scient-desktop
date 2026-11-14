/**
 * Reports each spoken request's turn to a call that runs in an agent of its own. The request goes
 * to the conversation as the user's message; this follows the conversation's events, finds the
 * run that message started, and passes on its progress and its answer for the voice to speak.
 */
import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * Whether a user message carries `request`: the request itself, or the request followed by what
 * the composer appends on later lines. A message that merely contains the request does not.
 */
const carries = (text: string, request: string): boolean => {
  const message = text.trim();
  return message === request || message.startsWith(`${request}\n`);
};

const STOPPED: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "The task failed before it finished.",
  cancelled: "The task was cancelled.",
  interrupted: "The task was stopped before it finished.",
  rolled_back: "The task was undone.",
};

export interface LiveVoiceTurnReporter {
  /** A spoken request was sent, or is about to be; its turn is the next to report. */
  readonly expect: (request: string) => void;
  /** One of the conversation's events, in order. */
  readonly observe: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
}

export function makeLiveVoiceTurnReporter(
  report: (text: string, final: boolean) => Effect.Effect<void>,
): LiveVoiceTurnReporter {
  const pending: string[] = [];
  let runId: RunId | undefined;
  /** The run's latest assistant message; an earlier one is progress once the next begins. */
  let latest: { readonly id: MessageId; readonly text: string } | undefined;

  const observe = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    if (event.type === "message.updated") {
      const message = event.payload;
      if (message.role === "user") {
        const request = pending[0];
        // A queued message gets its run when it starts; a turn already running is another's.
        if (runId !== undefined || request === undefined || message.runId === null) {
          return Effect.void;
        }
        if (!carries(message.text, request)) return Effect.void;
        pending.shift();
        runId = message.runId;
        latest = undefined;
        return Effect.void;
      }
      if (message.role !== "assistant" || runId === undefined || message.runId !== runId) {
        return Effect.void;
      }
      const previous = latest;
      latest = { id: message.id, text: message.text };
      return previous !== undefined && previous.id !== message.id && previous.text.trim()
        ? report(previous.text.trim(), false)
        : Effect.void;
    }
    if (event.type === "run.updated") {
      const run = event.payload;
      if (run.id !== runId || !isTerminalRunStatus(run.status)) return Effect.void;
      const answer = latest?.text.trim() || STOPPED[run.status] || "The task finished.";
      runId = undefined;
      latest = undefined;
      return report(answer, true);
    }
    return Effect.void;
  };

  return { expect: (request) => void pending.push(request.trim()), observe };
}
