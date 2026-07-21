import { Effect } from "effect";

import { isScientBackendShutdownMessage } from "@synara/shared/backendControl";

export interface DesktopParentMessageSource {
  readonly connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/** Completes when the Electron parent asks the scoped server runtime to shut down. */
export function waitForDesktopParentShutdown(
  source: DesktopParentMessageSource = process,
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    let settled = false;
    const cleanup = () => {
      source.off("message", onMessage);
      source.off("disconnect", onDisconnect);
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.void);
    };
    const onMessage = (message: unknown) => {
      if (!isScientBackendShutdownMessage(message)) return;
      complete();
    };
    const onDisconnect = () => complete();
    source.on("message", onMessage);
    source.on("disconnect", onDisconnect);
    // `disconnect` is edge-triggered. Register first, then inspect the current
    // channel state so a parent that disappeared during server startup cannot
    // leave an orphaned backend behind.
    if (source.connected === false) complete();
    return Effect.sync(cleanup);
  });
}
