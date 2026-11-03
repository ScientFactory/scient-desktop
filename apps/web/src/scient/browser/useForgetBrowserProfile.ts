import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { browserHistoryState } from "./browserHistoryState";
import { useBrowserShortcuts } from "./browserShortcuts";

const QUIET = { reportFailure: false, reportDefect: false };

/**
 * Drops a removed profile's shortcuts and history. Its id is never used again, so history an offline
 * server misses can't reappear, and that server drops it after 90 days anyway.
 */
export function useForgetBrowserProfile() {
  const { environments } = useEnvironments();
  const clearHistory = useAtomCommand(browserHistoryState.clear, QUIET);
  return (profileId: string) => {
    useBrowserShortcuts.getState().forgetProfile(profileId);
    for (const { environmentId } of environments) {
      void clearHistory({ environmentId, input: { profileId } });
    }
  };
}
