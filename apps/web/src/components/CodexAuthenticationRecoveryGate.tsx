// Purpose: Bridge a classified Codex runtime authentication failure into the
// single global provider-connection dialog without changing composer state.

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { useEffect } from "react";

import { findCodexAuthenticationRecoveryActivityId } from "~/lib/codexAuthRecovery";
import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";

// Recovery is offered once per durable runtime-error event for the lifetime of
// the renderer. Do not evict old ids: a thread can be remounted long after its
// activity window has rolled over, and evicting would reopen an already handled
// authentication prompt.
const handledRecoveryEventIds = new Set<string>();

function claimRecoveryEvent(eventId: string): boolean {
  if (handledRecoveryEventIds.has(eventId)) return false;
  handledRecoveryEventIds.add(eventId);
  return true;
}

export function CodexAuthenticationRecoveryGate(props: {
  readonly provider: ProviderKind;
  readonly sessionStatus: string | null | undefined;
  readonly sessionLastErrorEventId: string | null | undefined;
  readonly sessionLastErrorClass: string | null | undefined;
  readonly providerStatus: ServerProviderStatus | null | undefined;
}) {
  const recoveryActivityId = findCodexAuthenticationRecoveryActivityId(props);

  useEffect(() => {
    if (!recoveryActivityId) return;
    if (!claimRecoveryEvent(recoveryActivityId)) return;
    useProviderConnectionDialogStore.getState().openDialog("codex", "runtime_authentication_error");
  }, [recoveryActivityId]);

  return null;
}
