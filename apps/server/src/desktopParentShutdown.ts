import { Effect } from "effect";

import { isScientBackendShutdownMessage } from "@synara/shared/backendControl";

export interface DesktopParentMessageSource {
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
}

/** Completes when the Electron parent asks the scoped server runtime to shut down. */
export function waitForDesktopParentShutdown(
  source: DesktopParentMessageSource = process,
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const onMessage = (message: unknown) => {
      if (!isScientBackendShutdownMessage(message)) return;
      source.off("message", onMessage);
      resume(Effect.void);
    };
    source.on("message", onMessage);
    return Effect.sync(() => source.off("message", onMessage));
  });
}
