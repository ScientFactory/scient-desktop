import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useState } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountBrowserSessions,
  type AccountsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID } from "~/lib/utils";
import { accountsState } from "./accountsState";

const browserSessionSourceId = randomUUID();

export function useWebsiteSessions(
  environmentId: EnvironmentId | null,
  snapshot: AccountsSnapshot | null | undefined,
) {
  const registry = useContext(RegistryContext);
  const [observation, setObservation] = useState<{
    environmentId: EnvironmentId;
    snapshot: AccountsSnapshot;
    sessions: AccountBrowserSessions;
  } | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Read native cookie metadata on page open, account changes, focus and explicit sign-out; no polling.
  useEffect(() => {
    const bridge = window.desktopBridge?.accounts;
    if (!environmentId || !snapshot || !bridge?.cookieMetadata) return;
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      const profiles = [
        ...new Set(
          snapshot.accounts.flatMap((account) =>
            account.details.kind === "website"
              ? [account.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID]
              : [],
          ),
        ),
      ];
      const results = await Promise.all(
        profiles.map(async (profileId) => {
          const cookies = await bridge.cookieMetadata!(profileId, environmentId).catch(() => null);
          return cookies === null ? [] : [{ profileId, cookies }];
        }),
      );
      if (active && current === generation) {
        const sessions = results.flat();
        registry.refresh(
          accountsState.websiteSnapshot({
            environmentId,
            input: { browserSessions: sessions, browserSessionSourceId },
          }),
        );
        setObservation({ environmentId, snapshot, sessions });
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("scient-accounts-session-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("scient-accounts-session-changed", refresh);
    };
  }, [environmentId, snapshot, registry]);
  const current =
    observation?.environmentId === environmentId && observation.snapshot === snapshot
      ? observation
      : null;
  const query = useEnvironmentQuery(
    current
      ? accountsState.websiteSnapshot({
          environmentId: current.environmentId,
          input: { browserSessions: current.sessions, browserSessionSourceId },
        })
      : null,
  );
  return current && !query.error && !query.isPending ? (query.data ?? snapshot) : snapshot;
}
