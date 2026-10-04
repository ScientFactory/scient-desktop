import type {
  ProviderConnectionMethod,
  ProviderConnectionOperation,
  ProviderManagedRuntimeAction,
  ProviderRuntimeOperation,
  ProviderRuntimeSummary,
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

export function activeProviderRuntimeUpdateOperation(
  runtime: ProviderRuntimeSummary | null | undefined,
): ProviderRuntimeOperation | null {
  const operation = runtime?.operation;
  return operation?.action === "update" && isActiveProviderRuntimeOperation(operation)
    ? operation
    : null;
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

const RUNTIME_ACTION_NOUNS = {
  install: "installation",
  update: "update",
  repair: "repair",
  remove: "removal",
} satisfies Record<ProviderManagedRuntimeAction, string>;

/** The accessible name of a short "Cancel" button that stops a runtime operation. */
export function cancelRuntimeActionLabel(
  displayName: string,
  action: ProviderManagedRuntimeAction,
): string {
  return `Cancel ${displayName} ${RUNTIME_ACTION_NOUNS[action]}`;
}

/** The message of a runtime operation that failed while doing `action`. */
export function failedRuntimeOperationMessage(
  operation: ProviderRuntimeOperation | null | undefined,
  action: ProviderManagedRuntimeAction,
): string | null {
  return operation?.status === "failed" && operation.action === action ? operation.message : null;
}

/**
 * Why a managed runtime needs repair: a repair that failed, else the
 * provider's current error. An earlier failed install or update says nothing
 * about the runtime's present state.
 */
export function managedRuntimeRepairMessage(
  provider: ServerProvider,
  displayName: string,
  operation: ProviderRuntimeOperation | null | undefined = provider.connection?.runtime?.operation,
): string {
  return (
    failedRuntimeOperationMessage(operation, "repair") ??
    provider.message ??
    `${displayName}’s private runtime could not start.`
  );
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

export function shouldShowProviderLifecycleSetupInComposer(
  provider: ServerProvider | undefined,
  runtime: ProviderRuntimeSummary | null | undefined = provider?.connection?.runtime,
): boolean {
  const presentation = providerConnectionPresentation(provider);
  return (
    presentation.kind === "not-installed" ||
    (presentation.kind === "setting-up" &&
      activeProviderRuntimeUpdateOperation(runtime) === null) ||
    presentation.kind === "not-connected" ||
    presentation.kind === "connecting"
  );
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
/**
 * The installed private runtime failed its capability check, so a healthy
 * system runtime is standing in for it until the private copy is repaired or
 * updated.
 */
export function isManagedRuntimeBypassed(provider: ServerProvider | undefined): boolean {
  const runtime = provider?.connection?.runtime;
  return (
    runtime?.source === "system" &&
    runtime.managedVersion !== null &&
    runtime.actions.includes("repair")
  );
}

/** An installed runtime version this release does not support, which Scient can replace. */
export function hasInstallableCompatibilityRemedy(provider: ServerProvider | undefined): boolean {
  const status = provider?.compatibilityAdvisory?.status;
  return (
    (status === "unsupported" || status === "broken") &&
    (provider?.connection?.runtime?.actions.includes("install") ?? false)
  );
}

/** Provider execution errors can diagnose its runtime; Cursor SDK errors cannot diagnose its CLI. */
export function needsManagedRuntimeRecovery(provider: ServerProvider | undefined): boolean {
  const runtime = provider?.connection?.runtime;
  return (
    provider?.driver !== "cursor" &&
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
        : methods.includes("antigravity_credentials")
          ? "antigravity_credentials"
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
