import type {
  ProviderConnectionMethod,
  ProviderConnectionOperation,
  ProviderRuntimeOperation,
  ServerProvider,
} from "@t3tools/contracts";

const TERMINAL_CONNECTION_STATUSES = new Set<ProviderConnectionOperation["status"]>([
  "connected",
  "failed",
  "cancelled",
]);

const TERMINAL_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

export type ProviderConnectionPresentation =
  | { readonly kind: "unavailable"; readonly label: "Unavailable" }
  | { readonly kind: "not-installed"; readonly label: "Tool not installed" }
  | { readonly kind: "setting-up"; readonly label: "Setting up" }
  | { readonly kind: "not-required"; readonly label: "No sign-in needed" }
  | { readonly kind: "connected"; readonly label: "Connected" }
  | { readonly kind: "connecting"; readonly label: "Connecting" }
  | { readonly kind: "not-connected"; readonly label: "Not connected" }
  | { readonly kind: "unsupported"; readonly label: "Manual setup" };

export function isActiveProviderConnectionOperation(
  operation: ProviderConnectionOperation | null | undefined,
): boolean {
  return (
    operation !== null &&
    operation !== undefined &&
    !TERMINAL_CONNECTION_STATUSES.has(operation.status)
  );
}

export function isActiveProviderRuntimeOperation(
  operation: ProviderRuntimeOperation | null | undefined,
): boolean {
  return (
    operation !== null &&
    operation !== undefined &&
    !TERMINAL_RUNTIME_STATUSES.has(operation.status)
  );
}

export function providerLifecycleFailureMessage(value: unknown, fallback: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  ) {
    return value.message;
  }
  return fallback;
}

export function providerRuntimeComputerLabel(provider: ServerProvider): string {
  const target = provider.connection?.runtime?.target;
  if (target?.startsWith("darwin-")) return "this Mac";
  if (target?.startsWith("win32-")) return "this Windows computer";
  if (target?.startsWith("linux-")) return "this Linux computer";
  return "this computer";
}

export function providerAccountIdentity(provider: ServerProvider): string | null {
  return provider.auth.email?.trim() || provider.auth.label?.trim() || null;
}

export function hasActiveProviderRuntimeOperation(provider: ServerProvider | undefined): boolean {
  return isActiveProviderRuntimeOperation(provider?.connection?.runtime?.operation);
}

/**
 * A successful runtime operation can reach the provider stream one event
 * before the next probe updates `installed`. Treat the authoritative managed
 * runtime selection as installed so the UI hands off directly to account
 * setup instead of flashing an unusable install state.
 */
export function isProviderRuntimePresentedAsInstalled(
  provider: ServerProvider | undefined,
): boolean {
  return provider?.installed === true || provider?.connection?.runtime?.source === "scient_managed";
}

export function isProviderAccountConnected(provider: ServerProvider | undefined): boolean {
  return provider?.auth.status === "authenticated";
}

export function providerConnectionPresentation(
  provider: ServerProvider | undefined,
): ProviderConnectionPresentation {
  if (!provider || !provider.enabled || provider.availability === "unavailable") {
    return { kind: "unavailable", label: "Unavailable" };
  }
  if (hasActiveProviderRuntimeOperation(provider)) {
    return { kind: "setting-up", label: "Setting up" };
  }
  if (!isProviderRuntimePresentedAsInstalled(provider)) {
    return { kind: "not-installed", label: "Tool not installed" };
  }
  if (provider.auth.required === false) {
    return { kind: "not-required", label: "No sign-in needed" };
  }
  if (provider.auth.status === "authenticated") {
    return { kind: "connected", label: "Connected" };
  }
  if (isActiveProviderConnectionOperation(provider.connection?.operation)) {
    return { kind: "connecting", label: "Connecting" };
  }
  if ((provider.connection?.methods.length ?? 0) > 0) {
    return { kind: "not-connected", label: "Not connected" };
  }
  return { kind: "unsupported", label: "Manual setup" };
}

export function isProviderAccountPresentedAsConnected(
  provider: ServerProvider | undefined,
): boolean {
  return (
    providerConnectionPresentation(provider).kind === "connected" ||
    (hasActiveProviderRuntimeOperation(provider) && isProviderAccountConnected(provider))
  );
}

export function canManageProviderLifecycle(provider: ServerProvider | undefined): boolean {
  const runtime = provider?.connection?.runtime;
  if (runtime) return true;
  const presentation = providerConnectionPresentation(provider);
  return (
    presentation.kind === "setting-up" ||
    presentation.kind === "connected" ||
    presentation.kind === "connecting" ||
    presentation.kind === "not-connected"
  );
}

/**
 * A managed executable can still exist while its provider probe proves that it
 * no longer starts correctly. Route that state to runtime recovery instead of
 * presenting account sign-in as the next action.
 */
export function needsManagedRuntimeRecovery(provider: ServerProvider | undefined): boolean {
  const runtime = provider?.connection?.runtime;
  return (
    runtime?.source === "scient_managed" &&
    provider?.status === "error" &&
    provider.auth.status !== "unauthenticated"
  );
}

export function preferredProviderConnectionMethod(
  provider: ServerProvider,
): ProviderConnectionMethod | undefined {
  const methods = provider.connection?.methods ?? [];
  return methods.includes("codex_browser")
    ? "codex_browser"
    : methods.includes("claude_subscription")
      ? "claude_subscription"
      : methods.includes("antigravity_google")
        ? "antigravity_google"
        : methods.includes("grok_account")
          ? "grok_account"
          : methods.includes("droid_device_pairing")
            ? "droid_device_pairing"
            : methods.includes("cursor_browser")
              ? "cursor_browser"
              : methods.includes("codex_device_code")
                ? "codex_device_code"
                : methods.includes("grok_device_code")
                  ? "grok_device_code"
                  : methods.includes("claude_console")
                    ? "claude_console"
                    : undefined;
}

export function isSafeProviderAuthorizationUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
