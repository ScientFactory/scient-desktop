// FILE: providerUpdateRuntimePolicy.ts
// Purpose: Authoritatively route provider updates by runtime ownership and availability.
// Layer: Provider runtime policy

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";

import type { ResolvedProviderRuntime } from "./Services/ProviderRuntimeManager";

export function providerExternalUpdateBlockReason(
  provider: ProviderKind,
  runtime: ResolvedProviderRuntime,
): string | null {
  if (runtime.source === "managed" || runtime.source === "bundled") {
    return "This runtime is managed by Scient. Use Scient's verified managed update flow instead.";
  }
  if (!runtime.executable) {
    return `${PROVIDER_DISPLAY_NAMES[provider]} is not installed. Use Set up to install it before updating.`;
  }
  return null;
}
