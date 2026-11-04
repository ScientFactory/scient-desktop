import { EnvironmentId, type AccountsQualifyCase } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { accountsState } from "./accountsState";

declare global {
  interface Window {
    /** Dev desktops only: `qualify-session-copy.mjs --environment <id>` runs this. */
    scientQualifyRemoteSessions?: (
      environmentId: string,
    ) => Promise<ReadonlyArray<AccountsQualifyCase> | null>;
  }
}

/** Offered where the desktop offers its own qualification, which only a dev build does. */
export function offerRemoteQualification(registry: AtomRegistry.AtomRegistry) {
  if (!window.desktopBridge?.accounts?.qualifySessionCopy) return;
  window.scientQualifyRemoteSessions = async (environmentId) => {
    const result = await accountsState.sessionsQualify.run(registry, {
      environmentId: EnvironmentId.make(environmentId),
      input: {},
    });
    return result._tag === "Success" ? result.value : null;
  };
}
