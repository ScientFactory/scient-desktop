import {
  DEFAULT_PROVIDER_STARTING_MESSAGE,
  type EnvironmentId,
  type ProviderManagedRuntimeAction,
  type ServerProvider,
} from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import {
  hasInstallableCompatibilityRemedy,
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isManagedRuntimeBypassed,
  isUserFacingRuntimeFailure,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
} from "./providerConnectionPresentation";
import { m, type MessageResolver } from "~/i18n/messages";

import { hasExternalProviderUpdate } from "./providerLifecycleActions";
import { useProviderSignInStartingHere } from "./providerSignInStarting";

export interface ProviderSettingsVersionAdvisory {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
}

/** Managed copies keep compatibility guidance, with their lifecycle owner supplying updates. */
export function managedVersionAdvisory(
  advisory: ProviderSettingsVersionAdvisory | null,
  usesScientManagedRuntime: boolean,
): ProviderSettingsVersionAdvisory | null {
  return usesScientManagedRuntime
    ? advisory
      ? { ...advisory, updateCommand: null, targetVersion: null }
      : null
    : advisory;
}

export type ProviderSettingsLifecycleActionKind =
  | "runtime"
  | "external-update"
  | "sign-in"
  | "continue"
  | "manage";

export type ProviderSettingsLifecycleKind =
  | "checking"
  | "disabled"
  | "not-installed"
  | "installing"
  | "sign-in-required"
  | "signing-in"
  | "ready"
  | "attention"
  | "failed"
  | "manual";

export interface ProviderSettingsLifecyclePresentation {
  readonly kind: ProviderSettingsLifecycleKind;
  readonly statusLabel: string | null;
  readonly detail: string | null;
  readonly actionLabel: string | null;
  readonly actionKind: ProviderSettingsLifecycleActionKind | null;
  readonly runtimeAction: ProviderManagedRuntimeAction | null;
  readonly busy: boolean;
  /** Download-only progress; not an estimate of the whole operation. */
  readonly downloadPercent?: number;
}

function action(input: {
  readonly kind: ProviderSettingsLifecycleActionKind;
  readonly label: string;
  readonly runtimeAction?: ProviderManagedRuntimeAction;
}) {
  return {
    actionKind: input.kind,
    actionLabel: input.label,
    runtimeAction: input.runtimeAction ?? null,
  } as const;
}

const NO_ACTION = {
  actionKind: null,
  actionLabel: null,
  runtimeAction: null,
} as const;

const RUNTIME_ACTION_LABELS = {
  install: msg("Installing", { $context: "provider status" }),
  update: msg("Updating", { $context: "provider status" }),
  repair: msg("Repairing", { $context: "provider status" }),
  remove: msg("Removing", { $context: "provider status" }),
} satisfies Record<ProviderManagedRuntimeAction, string>;

/**
 * {@link providerSettingsLifecyclePresentation}, showing a sign-in this client
 * just started as starting from the click.
 */
export function useProviderSettingsLifecyclePresentation(
  environmentId: EnvironmentId,
  provider: ServerProvider | undefined,
  displayName: string,
): ProviderSettingsLifecyclePresentation {
  const startingHere = useProviderSignInStartingHere({
    environmentId,
    instanceId: provider?.instanceId ?? ("" as ServerProvider["instanceId"]),
  });
  const resolve = useMessages();
  return providerSettingsLifecyclePresentation(provider, displayName, {
    startingHere: provider !== undefined && startingHere,
    resolve,
  });
}

export function providerSettingsLifecyclePresentation(
  provider: ServerProvider | undefined,
  displayName: string,
  options: { readonly startingHere?: boolean; readonly resolve?: MessageResolver } = {},
): ProviderSettingsLifecyclePresentation {
  const r = options.resolve ?? m;
  if (!provider) {
    return {
      kind: "checking",
      statusLabel: null,
      detail: r(msg("Checking installation and sign-in status…")),
      ...NO_ACTION,
      busy: true,
    };
  }
  const runtimeOperation = provider.connection?.runtime?.operation ?? null;
  if (runtimeOperation && isActiveProviderRuntimeOperation(runtimeOperation)) {
    const label = r(
      runtimeOperation.waitingForIdle
        ? msg("Waiting", { $context: "provider status" })
        : runtimeOperation.retrying
          ? msg("Retrying", { $context: "provider status" })
          : runtimeOperation.status === "verifying" || runtimeOperation.status === "testing"
            ? msg("Verifying", { $context: "provider status" })
            : RUNTIME_ACTION_LABELS[runtimeOperation.action],
    );
    const { downloadedBytes, totalBytes } = runtimeOperation;
    const downloadPercent =
      runtimeOperation.status === "downloading" &&
      !runtimeOperation.retrying &&
      downloadedBytes !== undefined &&
      totalBytes !== undefined &&
      Number.isFinite(downloadedBytes) &&
      Number.isFinite(totalBytes) &&
      totalBytes > 0
        ? Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)))
        : undefined;
    return {
      kind: "installing",
      statusLabel: label,
      detail: runtimeOperation.message,
      ...action({ kind: "continue", label }),
      busy: true,
      ...(downloadPercent !== undefined ? { downloadPercent } : {}),
    };
  }
  if (!provider.enabled) {
    return {
      kind: "disabled",
      statusLabel: r(msg("Disabled", { $context: "provider status" })),
      detail: r(msg("Hidden from new conversations.")),
      ...action({
        kind: "manage",
        label: r(msg("Manage", { $context: "verb, provider settings button" })),
      }),
      busy: false,
    };
  }
  if (provider.probePending === true) {
    return {
      kind: "checking",
      statusLabel: null,
      detail: null,
      ...NO_ACTION,
      busy: true,
    };
  }
  if (runtimeOperation && isUserFacingRuntimeFailure(runtimeOperation)) {
    return {
      kind: "failed",
      statusLabel: r(msg("Setup failed", { $context: "provider status" })),
      detail: runtimeOperation.message,
      ...action({
        kind: "manage",
        label: r(msg("Failed", { $context: "provider settings button after a failed setup" })),
      }),
      busy: false,
    };
  }
  if (
    !isProviderRuntimePresentedAsInstalled(provider) ||
    provider.connection?.runtime?.source === "missing"
  ) {
    const canInstall = provider.connection?.runtime?.actions.includes("install") ?? false;
    return {
      kind: "not-installed",
      statusLabel: r(msg("Not installed", { $context: "provider status" })),
      detail:
        provider.driver === "codex"
          ? r(msg("Install Codex to connect your ChatGPT account."))
          : provider.driver === "pi"
            ? r(msg("Install Pi, then configure its model providers."))
            : r(msg("Install {provider} to connect your account.", { provider: displayName })),
      ...(canInstall
        ? action({
            kind: "runtime",
            label: r(msg("Install", { $context: "verb, provider settings button" })),
            runtimeAction: "install",
          })
        : action({
            kind: "manage",
            label: r(msg("Manage", { $context: "verb, provider settings button" })),
          })),
      busy: false,
    };
  }

  if (provider.connection?.runtime?.actions.includes("update")) {
    return {
      kind: "attention",
      statusLabel: r(msg("Update available", { $context: "provider status" })),
      detail: r(
        msg("A reviewed {provider} update is ready to install.", { provider: displayName }),
      ),
      ...action({
        kind: "runtime",
        label: r(msg("Update", { $context: "verb, provider settings button" })),
        runtimeAction: "update",
      }),
      busy: false,
    };
  }
  if (isManagedRuntimeBypassed(provider)) {
    return {
      kind: "attention",
      statusLabel: r(msg("Using system {provider}", { provider: displayName })),
      detail: provider.connection?.runtime?.message ?? null,
      ...action({
        kind: "runtime",
        label: r(msg("Repair", { $context: "verb, provider settings button" })),
        runtimeAction: "repair",
      }),
      busy: false,
    };
  }
  if (hasExternalProviderUpdate(provider)) {
    return {
      kind: "attention",
      statusLabel: r(msg("Update available", { $context: "provider status" })),
      detail:
        provider.versionAdvisory?.message ??
        r(
          msg("A newer {provider} version is available on this computer.", {
            provider: displayName,
          }),
        ),
      ...action({
        kind: "external-update",
        label: r(msg("Update", { $context: "verb, provider settings button" })),
      }),
      busy: false,
    };
  }
  if (hasInstallableCompatibilityRemedy(provider)) {
    return {
      kind: "attention",
      statusLabel:
        provider.compatibilityAdvisory?.status === "broken"
          ? r(msg("Incompatible version"))
          : r(msg("Unsupported version")),
      detail: r(
        msg(
          "{advisory} Install Scient''s verified {provider} to use a supported version; the current installation stays untouched.",
          {
            advisory:
              provider.compatibilityAdvisory?.message ??
              r(msg("This {provider} version is not supported.", { provider: displayName })),
            provider: displayName,
          },
        ),
      ),
      ...action({
        kind: "runtime",
        label: r(msg("Install", { $context: "verb, provider settings button" })),
        runtimeAction: "install",
      }),
      busy: false,
    };
  }
  if (needsManagedRuntimeRecovery(provider)) {
    const canRepair = provider.connection?.runtime?.actions.includes("repair") ?? false;
    return {
      kind: "attention",
      statusLabel: r(msg("Runtime needs repair", { $context: "provider status" })),
      detail:
        provider.message ??
        r(msg("{provider} could not start correctly.", { provider: displayName })),
      ...(canRepair
        ? action({
            kind: "runtime",
            label: r(msg("Repair", { $context: "verb, provider settings button" })),
            runtimeAction: "repair",
          })
        : action({
            kind: "manage",
            label: r(msg("Manage", { $context: "verb, provider settings button" })),
          })),
      busy: false,
    };
  }

  if (provider.driver === "pi") {
    const discovered = provider.status === "ready" && provider.models.length > 0;
    return {
      kind: discovered ? "ready" : "manual",
      statusLabel: discovered ? r(msg("Models available")) : r(msg("Configure Pi")),
      detail: provider.message ?? r(msg("Connect a custom model or configure a provider in Pi.")),
      ...action({
        kind: "manage",
        label: r(msg("Manage", { $context: "verb, provider settings button" })),
      }),
      busy: false,
    };
  }
  if (provider.auth.status === "authenticated" || provider.auth.required === false) {
    if (provider.status !== "ready" || provider.models.length === 0) {
      return {
        kind: "attention",
        statusLabel: r(msg("Needs attention", { $context: "provider status" })),
        detail:
          provider.message ??
          r(msg("{provider} is connected but has no available model.", { provider: displayName })),
        ...action({
          kind: "manage",
          label: r(msg("Manage", { $context: "verb, provider settings button" })),
        }),
        busy: false,
      };
    }
    return {
      kind: "ready",
      statusLabel: r(msg("Ready", { $context: "provider status" })),
      detail:
        provider.auth.required === false
          ? r(msg("Ready without account sign-in."))
          : (provider.auth.label ?? provider.auth.email ?? r(msg("Account connected."))),
      ...action({
        kind: "manage",
        label: r(msg("Manage", { $context: "verb, provider settings button" })),
      }),
      busy: false,
    };
  }
  const connectionOperation = provider.connection?.operation ?? null;
  // This client's start is in flight and the server has not yet reported it.
  if (options.startingHere && !isActiveProviderConnectionOperation(connectionOperation)) {
    return {
      kind: "signing-in",
      statusLabel: r(msg("Starting", { $context: "provider status" })),
      detail: provider.connection?.startingMessage ?? DEFAULT_PROVIDER_STARTING_MESSAGE,
      ...action({
        kind: "continue",
        label: r(msg("Continue", { $context: "verb, provider settings button" })),
      }),
      busy: true,
    };
  }
  if (connectionOperation?.status === "failed") {
    const canRetrySignIn = (provider.connection?.methods.length ?? 0) > 0;
    return {
      kind: "failed",
      statusLabel: connectionOperation.failedAfterSignIn
        ? r(msg("Setup failed", { $context: "provider status" }))
        : r(msg("Sign-in failed", { $context: "provider status" })),
      // After the sign-in finished, the server's sentence is diagnostic; say what happened.
      detail: connectionOperation.failedAfterSignIn
        ? connectionOperation.method.endsWith("_credentials")
          ? r(
              msg("Connected, but {provider} couldn’t start. Try again.", {
                provider: displayName,
              }),
            )
          : r(
              msg("Signed in, but {provider} couldn’t start. Try again.", {
                provider: displayName,
              }),
            )
        : connectionOperation.message,
      ...(canRetrySignIn
        ? action({
            kind: "sign-in",
            label: r(msg("Retry", { $context: "verb, provider settings button" })),
          })
        : action({
            kind: "manage",
            label: r(msg("Manage", { $context: "verb, provider settings button" })),
          })),
      busy: false,
    };
  }
  if (connectionOperation && isActiveProviderConnectionOperation(connectionOperation)) {
    return {
      kind: "signing-in",
      statusLabel:
        connectionOperation.status === "verifying"
          ? r(msg("Verifying", { $context: "provider status" }))
          : connectionOperation.status === "starting"
            ? r(msg("Starting", { $context: "provider status" }))
            : r(msg("Signing in", { $context: "provider status" })),
      detail: connectionOperation.message,
      ...action({
        kind: "continue",
        label: r(msg("Continue", { $context: "verb, provider settings button" })),
      }),
      busy: true,
    };
  }
  if ((provider.connection?.methods.length ?? 0) > 0) {
    return {
      kind: "sign-in-required",
      statusLabel: r(msg("Sign-in required", { $context: "provider status" })),
      detail:
        provider.driver === "codex"
          ? r(msg("Connect your ChatGPT account."))
          : provider.driver === "droid"
            ? r(msg("Sign in with your existing Factory subscription."))
            : r(msg("Connect your account.")),
      ...action({
        kind: "sign-in",
        label: r(msg("Sign in", { $context: "verb, provider settings button" })),
      }),
      busy: false,
    };
  }
  return {
    kind: "manual",
    statusLabel: r(msg("Manual setup", { $context: "provider status" })),
    detail: provider.message ?? r(msg("Use the provider's advanced configuration.")),
    ...NO_ACTION,
    busy: false,
  };
}
