// Purpose: Bridge a classified Codex runtime authentication failure into the
// single global provider-connection dialog without changing composer state.

import type {
  OrchestrationThreadActivity,
  ProviderKind,
  ServerProviderStatus,
} from "@synara/contracts";
import { useEffect, useMemo, useRef } from "react";

import { findCodexAuthenticationRecoveryActivityId } from "~/lib/codexAuthRecovery";
import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";

export function CodexAuthenticationRecoveryGate(props: {
  readonly provider: ProviderKind;
  readonly sessionStatus: string | null | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly providerStatus: ServerProviderStatus | null | undefined;
}) {
  const handledActivityIdsRef = useRef<Set<string>>(new Set());
  const recoveryActivityId = useMemo(
    () => findCodexAuthenticationRecoveryActivityId(props),
    [props.activities, props.provider, props.providerStatus, props.sessionStatus],
  );

  useEffect(() => {
    if (!recoveryActivityId) return;
    const handledIds = handledActivityIdsRef.current;
    if (handledIds.has(recoveryActivityId)) return;
    if (handledIds.size >= 50) {
      const oldestId = handledIds.values().next().value;
      if (oldestId) handledIds.delete(oldestId);
    }
    handledIds.add(recoveryActivityId);
    useProviderConnectionDialogStore.getState().openDialog("codex", "runtime_authentication_error");
  }, [recoveryActivityId]);

  return null;
}
