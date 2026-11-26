import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { accountsState } from "./accountsState";

const INCOMPLETE_RETRY_MS = 5_000;
const MAX_INCOMPLETE_RETRIES = 3;

/**
 * Loads external GitHub identities on demand and retries while the view stays open whenever the
 * server reports an incomplete result (e.g., transient gh/API timeout) so recovery propagates.
 */
export function useAccountsExternalIdentities(environmentId: EnvironmentId | null, enabled = true) {
  const query = useEnvironmentQuery(
    enabled && environmentId !== null
      ? accountsState.externalIdentities({ environmentId, input: {} })
      : null,
  );
  const incomplete = query.data?.complete === false;
  const refresh = query.refresh;
  const retryCountRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Schedules a bounded retry timer while mounted when external identity discovery returned an incomplete result.
  useEffect(() => {
    if (!enabled || environmentId === null || !incomplete) {
      retryCountRef.current = 0;
      return;
    }
    if (query.isPending || retryCountRef.current >= MAX_INCOMPLETE_RETRIES) return;
    const timer = setTimeout(() => {
      retryCountRef.current += 1;
      refresh();
    }, INCOMPLETE_RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, environmentId, incomplete, query.isPending, refresh]);

  return query;
}
