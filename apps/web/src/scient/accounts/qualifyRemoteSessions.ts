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

/** Dev builds only, where the desktop offers its own qualification too. */
export function offerRemoteQualification(registry: AtomRegistry.AtomRegistry) {
  if (!import.meta.env.DEV || !window.desktopBridge?.accounts?.qualifySessionCopy) return;
  window.scientQualifyRemoteSessions = async (environmentId) => {
    const result = await accountsState.sessionsQualify.run(registry, {
      environmentId: EnvironmentId.make(environmentId),
      input: {},
    });
    return result._tag === "Success" ? result.value : null;
  };
}
