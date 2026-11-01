/**
 * Derive key hints from the real composer submission-intent policy so queue/steer, follow-up, and
 * send-shortcut settings cannot drift from behavior. See docs/internals/scient-thread-queue.md.
 */

import {
  composerSubmissionIntentForEnter,
  type ComposerSubmissionIntent,
} from "../../composer-logic";

export interface ComposerWorkingPlaceholderInput {
  readonly isRunning: boolean;
  readonly isMobileViewport: boolean;
  readonly followUpBehavior: "queue" | "steer";
  readonly sendShortcut: "enter" | "mod-enter" | "mod-enter-multiline";
  readonly prompt: string;
  readonly isMacPlatform: boolean;
}

const actionLabelForIntent = (
  intent: ComposerSubmissionIntent,
  followUpBehavior: "queue" | "steer",
): string => {
  const queued = followUpBehavior === "queue";
  // "background" never occurs while a server turn is running, but map it to
  // the default disposition rather than crashing if T3 ever returns it here.
  if (intent !== "alternate") return queued ? "queue" : "steer";
  return queued ? "steer" : "queue";
};

/**
 * Desktop hints must mirror actual submission keys. Mobile Enter does not submit, so use status
 * text and let its send button communicate Queue message.
 */
export function resolveComposerWorkingPlaceholder(
  input: ComposerWorkingPlaceholderInput,
): string | null {
  if (!input.isRunning) return null;
  if (input.isMobileViewport) return "Agent is working…";

  const modifier = input.isMacPlatform ? "⌘" : "Ctrl";
  // Desktop-only hint computation; the mobile case returned above.
  const intentFor = (shiftKey: boolean, modifierKey: boolean) =>
    composerSubmissionIntentForEnter({
      isMobileViewport: false,
      shiftKey,
      modifierKey,
      isDraftThread: false,
      isRunning: true,
      sendShortcut: input.sendShortcut,
      prompt: input.prompt,
    });

  const candidates: ReadonlyArray<readonly [string, ComposerSubmissionIntent | null]> = [
    ["Enter", intentFor(false, false)],
    [`${modifier}+Enter`, intentFor(false, true)],
    [`⇧${modifier}+Enter`, intentFor(true, true)],
  ];

  const hints: string[] = [];
  for (const [key, intent] of candidates) {
    if (intent === null) continue;
    hints.push(`${key} to ${actionLabelForIntent(intent, input.followUpBehavior)}`);
  }
  if (hints.length === 0) return "Agent is working…";
  return `Agent is working… ${hints.join(", ")}`;
}
