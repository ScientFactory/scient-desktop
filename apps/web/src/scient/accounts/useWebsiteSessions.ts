import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useState } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountBrowserSessions,
  type AccountsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID } from "~/lib/utils";
import { accountsState } from "./accountsState";

const browserSessionSourceId = randomUUID();

export function useWebsiteSessions(
  environmentId: EnvironmentId | null,
  snapshot: AccountsSnapshot | null | undefined,
) {
  const registry = useContext(RegistryContext);
  const defaultProfileId =
    useClientSettings((settings) => settings.browserDefaultProfileId) ?? DEFAULT_BROWSER_PROFILE_ID;
  const [observation, setObservation] = useState<{
    environmentId: EnvironmentId;
    snapshot: AccountsSnapshot;
    sessions: AccountBrowserSessions;
    defaultProfileId: string;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read native cookie metadata on page open, account changes, focus and explicit sign-out; no polling.
  useEffect(() => {
    const bridge = window.desktopBridge?.accounts;
    if (!environmentId || !snapshot || !bridge?.cookieMetadata) return;
    let active = true;
    // A counter object: React Compiler can't lower `++` on a variable captured by a closure.
    const generation = { value: 0 };
    const refresh = async () => {
      generation.value += 1;
      const current = generation.value;
      const profiles = [
        ...new Set(
          snapshot.accounts.flatMap((account) =>
            account.details.kind === "website"
              ? [account.details.profileId ?? defaultProfileId]
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
      if (active && current === generation.value) {
        const sessions = results.flat();
        registry.refresh(
          accountsState.websiteSnapshot({
            environmentId,
            input: { browserSessions: sessions, browserSessionSourceId, defaultProfileId },
          }),
        );
        setObservation({ environmentId, snapshot, sessions, defaultProfileId });
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
  }, [environmentId, snapshot, registry, defaultProfileId]);
  const current =
    observation?.environmentId === environmentId &&
    observation.snapshot === snapshot &&
    observation.defaultProfileId === defaultProfileId
      ? observation
      : null;
  const query = useEnvironmentQuery(
    current
      ? accountsState.websiteSnapshot({
          environmentId: current.environmentId,
          input: {
            browserSessions: current.sessions,
            browserSessionSourceId,
            defaultProfileId: current.defaultProfileId,
          },
        })
      : null,
  );
  return current && !query.error && !query.isPending ? (query.data ?? snapshot) : snapshot;
}
