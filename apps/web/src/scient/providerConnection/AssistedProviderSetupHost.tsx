import type { EnvironmentId, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import {
  LoaderIcon,
  LogOutIcon,
  PowerIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import { ClaudeInlineSetup } from "./ClaudeInlineSetup";
import { CodexInlineSetup } from "./CodexInlineSetup";
import { CursorInlineSetup } from "./CursorInlineSetup";
import { DroidInlineSetup } from "./DroidInlineSetup";
import { GrokInlineSetup } from "./GrokInlineSetup";
import {
  DESTRUCTIVE_GHOST_ACTION_CLASS,
  PRIMARY_GHOST_ACTION_CLASS,
} from "./providerConnectionActionStyles";
import {
  isProviderAccountPresentedAsConnected,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";
import { useProviderEnableAction } from "./useProviderEnableAction";

export type AssistedProviderSetupSurface = "composer" | "management";

export function supportsAssistedProviderSetupSurface(
  driver: ProviderDriverKind,
  surface: AssistedProviderSetupSurface,
): boolean {
  switch (driver) {
    case "antigravity":
      return surface === "composer";
    case "claudeAgent":
    case "codex":
    case "cursor":
    case "droid":
    case "grok":
      return true;
    default:
      return false;
  }
}

interface AssistedProviderSetupHostBaseProps {
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}

type AssistedProviderSetupHostProps = AssistedProviderSetupHostBaseProps &
  (
    | { readonly surface: "composer" }
    | {
        readonly surface: "management";
        readonly accountActionDisabled: boolean;
        readonly managedRuntimePresentedExternally: boolean;
        readonly onAccountActionPendingChange: (pending: boolean) => void;
        readonly onRepairSucceeded: () => void;
      }
  );

/**
 * The single frontend dispatch seam for assisted provider setup. Provider
 * flows stay in their own inline views; this host owns only controller
 * construction and the management surface's shared account action.
 */
export function AssistedProviderSetupHost(props: AssistedProviderSetupHostProps) {
  if (!supportsAssistedProviderSetupSurface(props.provider.driver, props.surface)) return null;
  const displayName =
    props.displayName.trim() || props.provider.displayName?.trim() || String(props.provider.driver);
  if (!props.provider.enabled) {
    return (
      <DisabledProviderSetup
        displayName={displayName}
        environmentId={props.environmentId}
        provider={props.provider}
      />
    );
  }
  if (props.provider.probePending === true) {
    return <ProviderProbePendingSetup displayName={displayName} />;
  }
  return <SupportedAssistedProviderSetupHost {...props} />;
}

export function ProviderProbePendingSetup(props: { readonly displayName: string }) {
  return (
    <AssistedSetupFrame>
      <div
        aria-label={`Checking ${props.displayName} status`}
        className="flex min-h-8 items-center justify-center text-muted-foreground"
        role="status"
      >
        <LoaderIcon aria-hidden className="size-5 animate-spin" />
      </div>
    </AssistedSetupFrame>
  );
}

function SupportedAssistedProviderSetupHost(props: AssistedProviderSetupHostProps) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const displayName =
    props.displayName.trim() || props.provider.displayName?.trim() || String(props.provider.driver);
  const isManagement = props.surface === "management";

  const disconnect = async () => {
    setDisconnecting(true);
    if (isManagement) props.onAccountActionPendingChange(true);
    setDisconnectError(null);
    try {
      await controller.disconnect();
    } catch (error) {
      setDisconnectError(
        providerLifecycleFailureMessage(error, `Scient could not sign out of ${displayName}.`),
      );
    } finally {
      setDisconnecting(false);
      if (isManagement) props.onAccountActionPendingChange(false);
    }
  };

  const accountAction =
    isManagement &&
    isProviderAccountPresentedAsConnected(props.provider) &&
    props.provider.connection?.canDisconnect ? (
      <Button
        className={DESTRUCTIVE_GHOST_ACTION_CLASS}
        disabled={disconnecting || props.accountActionDisabled}
        onClick={() => void disconnect()}
        size="sm"
        type="button"
        variant="ghost-muted"
      >
        {disconnecting ? <LoaderIcon className="animate-spin" /> : <LogOutIcon />}
        Sign out
      </Button>
    ) : undefined;

  const managementProps = isManagement
    ? {
        accountAction,
        managedRuntimePresentedExternally: props.managedRuntimePresentedExternally,
        onRepairSucceeded: props.onRepairSucceeded,
      }
    : {};

  let setup: ReactNode;
  switch (props.provider.driver) {
    case "antigravity":
      setup =
        props.surface === "composer" ? (
          <AntigravityInlineSetup
            controller={controller}
            displayName={displayName}
            provider={props.provider}
          />
        ) : null;
      break;
    case "claudeAgent":
      setup = (
        <ClaudeInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "codex":
      setup = (
        <CodexInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "cursor":
      setup = (
        <CursorInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "droid":
      setup = (
        <DroidInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "grok":
      setup = (
        <GrokInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    default:
      setup = null;
  }

  if (setup === null) return null;
  return (
    <>
      {setup}
      {isManagement && disconnectError ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-destructive text-xs leading-relaxed"
          role="alert"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{disconnectError}</span>
        </div>
      ) : null}
    </>
  );
}

export function DisabledProviderSetup(props: {
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}) {
  const { access, canEnable, enable } = useProviderEnableAction({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runEnable = async () => {
    setError(null);
    setEnabling(true);
    try {
      await enable();
      // Keep the pending state until the canonical provider snapshot reports
      // enabled. This component then unmounts and the next action is revealed;
      // installation or sign-in is never started implicitly.
    } catch (cause) {
      setEnabling(false);
      setError(
        providerLifecycleFailureMessage(cause, `Scient could not enable ${props.displayName}.`),
      );
    }
  };

  const body = error
    ? error
    : access === "pending"
      ? `Checking whether this session can enable ${props.displayName}.`
      : access === "denied"
        ? `This session can view ${props.displayName}, but cannot enable it.`
        : canEnable
          ? `Enable ${props.displayName} to continue.`
          : `Open provider settings to enable ${props.displayName}.`;

  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={body}
        icon={
          error ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ShieldCheckIcon className="size-5 text-primary" />
          )
        }
        role={error ? "alert" : undefined}
        title={
          error ? `${props.displayName} couldn’t be enabled` : `${props.displayName} is disabled`
        }
      />
      {canEnable ? (
        <AssistedSetupActions>
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            disabled={enabling}
            onClick={() => void runEnable()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {enabling ? (
              <LoaderIcon aria-hidden className="animate-spin" />
            ) : (
              <PowerIcon aria-hidden />
            )}
            {enabling ? "Enabling…" : "Enable"}
          </Button>
        </AssistedSetupActions>
      ) : null}
    </AssistedSetupFrame>
  );
}
