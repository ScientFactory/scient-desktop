// FILE: providerSignOutRequest.ts
// Purpose: Confirm the account-wide effect before invoking provider CLI sign-out.
// Layer: Web client utility

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderConnectionResult,
} from "@synara/contracts";
import type { ProviderSignOutNativeApi } from "@synara/shared/providerSignOutTransport";

export function providerSignOutConfirmationMessage(provider: ProviderKind): string {
  const label = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return [
    `Sign out of ${label}?`,
    `Scient will run ${label}'s official CLI sign-out command. This can also sign you out in terminals and other apps that use the same CLI account.`,
  ].join("\n");
}

export async function requestProviderSignOut(
  api: Pick<ProviderSignOutNativeApi, "dialogs" | "server">,
  provider: ProviderKind,
): Promise<ServerProviderConnectionResult | null> {
  const confirmed = await api.dialogs.confirm(providerSignOutConfirmationMessage(provider));
  if (!confirmed) return null;
  return api.server.signOutProvider({ provider });
}
