import type { QueuedRunsControlHandle } from "./QueuedRunsControl";

/** Only consume the key when the native queue actually accepts the action. */
export function handleQueuedRunShortcut(
  command: string | undefined,
  event: Pick<KeyboardEvent, "repeat" | "preventDefault" | "stopPropagation">,
  queue: QueuedRunsControlHandle | null,
): boolean {
  const handled =
    command === "thread.steerQueuedMessage"
      ? queue?.steerNext(event.repeat)
      : command === "thread.editQueuedMessage"
        ? queue?.editLatest(event.repeat)
        : false;
  if (!handled) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
