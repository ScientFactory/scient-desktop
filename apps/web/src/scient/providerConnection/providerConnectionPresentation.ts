import type { ProviderConnectionMethod, ServerProvider } from "@t3tools/contracts";

export type ProviderConnectionPresentation =
  | { readonly kind: "unavailable"; readonly label: "Unavailable" }
  | { readonly kind: "not-installed"; readonly label: "Tool not installed" }
  | { readonly kind: "setting-up"; readonly label: "Setting up" }
  | { readonly kind: "not-required"; readonly label: "No sign-in needed" }
  | { readonly kind: "connected"; readonly label: "Connected" }
  | { readonly kind: "connecting"; readonly label: "Connecting" }
  | { readonly kind: "not-connected"; readonly label: "Not connected" }
  | { readonly kind: "unsupported"; readonly label: "Manual setup" };

export function providerConnectionPresentation(
  provider: ServerProvider | undefined,
): ProviderConnectionPresentation {
  if (!provider || !provider.enabled || provider.availability === "unavailable") {
    return { kind: "unavailable", label: "Unavailable" };
  }
  const runtimeOperation = provider.connection?.runtime?.operation;
  if (
    runtimeOperation &&
    runtimeOperation.status !== "succeeded" &&
    runtimeOperation.status !== "failed" &&
    runtimeOperation.status !== "cancelled"
  ) {
    return { kind: "setting-up", label: "Setting up" };
  }
  if (!provider.installed) {
    return { kind: "not-installed", label: "Tool not installed" };
  }
  if (provider.auth.required === false) {
    return { kind: "not-required", label: "No sign-in needed" };
  }
  if (provider.auth.status === "authenticated") {
    return { kind: "connected", label: "Connected" };
  }
  const operation = provider.connection?.operation;
  if (
    operation &&
    operation.status !== "failed" &&
    operation.status !== "cancelled" &&
    operation.status !== "connected"
  ) {
    return { kind: "connecting", label: "Connecting" };
  }
  if ((provider.connection?.methods.length ?? 0) > 0) {
    return { kind: "not-connected", label: "Not connected" };
  }
  return { kind: "unsupported", label: "Manual setup" };
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

export function preferredProviderConnectionMethod(
  provider: ServerProvider,
): ProviderConnectionMethod | undefined {
  const methods = provider.connection?.methods ?? [];
  return methods.includes("codex_browser")
    ? "codex_browser"
    : methods.includes("claude_subscription")
      ? "claude_subscription"
      : methods.includes("codex_device_code")
        ? "codex_device_code"
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
